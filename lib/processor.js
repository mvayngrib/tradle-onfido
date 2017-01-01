
const { EventEmitter } = require('events')
const pump = require('pump')
const through = require('through2')
const Promise = require('bluebird')
const co = Promise.coroutine
const backoff = require('backoff')
const omit = require('object.omit')
const debug = require('debug')('tradle:onfido:processor')
const { constants, utils } = require('@tradle/engine')
const createRetryStream = require('@tradle/engine/lib/retrystream')
const { TYPE } = constants
const topics = require('./topics')
const status = require('./status')
const getCheckStatus = status.getCheckStatus
const tradleToOnfidoType = require('./typemap')
const convert = require('./convert')
const DEV = require('./dev')

module.exports = function processor (opts) {
  let { api, db, changes, keeper } = opts
  changes = Promise.promisifyAll(changes)
  keeper = Promise.promisifyAll(keeper)
  const myDebug = debug // tradle.utils.subdebugger()

  function createAndUpdateApplicants () {
    // const creator = createRetryStream({
    //     worker: createApplicant,
    //     primaryKey: 'permalink',
    //     backoff: backoff.exponential({
    //       randomisationFactor: 0,
    //       initialDelay: 1000,
    //       maxDelay: 600000
    //     })
    //   })
    //   .on('error', err => ee.emit('error', err))

    const sources = [
      db.streamApplicantsToCreate({ live: true, keys: false }),
      db.streamApplicantsToUpdate({ live: true, keys: false })
    ]

    sources.forEach(source => {
      pump(
        source,
        through.obj(callbackify(addPersonalInfo)),
        through.obj(callbackify(createOrUpdateApplicant)),
        through.obj(function (data, enc, cb) {
          // drain
          myDebug(`created or updated onfido applicant with id: ${data.id}`)
          cb()
        })
      )
    })

    return () => {
      sources.forEach(source => source.end())
    }
  }

  function uploadDocuments () {
    // const creator = createRetryStream({
    //     worker: uploadDocument,
    //     primaryKey: 'link',
    //     backoff: newBackoff()
    //   })
    //   .on('error', err => ee.emit('error', err))

    const source = db.streamDocumentsToCreate({ live: true, keys: false })
    pump(
      source,
      through.obj(callbackify(addBody)),
      through.obj(callbackify(uploadDocument)),
      through.obj(function (document, enc, cb) {
        // drain
        myDebug(`uploaded document ${document.id} to onfido`)
        cb()
      })
    )

    return source.end.bind(source)
  }

  function uploadFaces () {
    // const creator = createRetryStream({
    //     worker: uploadDocument,
    //     primaryKey: 'link',
    //     backoff: newBackoff()
    //   })
    //   .on('error', err => ee.emit('error', err))

    const source = db.streamFacesToUpload({ live: true, keys: false })
    pump(
      source,
      through.obj(callbackify(addBody)),
      through.obj(callbackify(uploadFace)),
      through.obj(function (face, enc, cb) {
        // drain
        myDebug(`uploaded face ${face.id} to onfido`)
        cb()
      })
    )

    return source.end.bind(source)
  }

  function createChecks () {
    // const creator = createRetryStream({
    //     worker: uploadDocument,
    //     primaryKey: 'link',
    //     backoff: newBackoff()
    //   })
    //   .on('error', err => ee.emit('error', err))

    const source = db.streamChecksToCreate({ live: true, keys: false })
    pump(
      source,
      through.obj(callbackify(createCheck)),
      through.obj(function (check, enc, cb) {
        // drain
        myDebug(`created check ${check.id} on onfido`)
        cb()
      })
    )

    return source.end.bind(source)
  }

  function updateChecks () {
    const checker = createRetryStream({
        worker: callbackify(updateCheck),
        primaryKey: 'document',
        backoff: backoff.exponential({
          randomisationFactor: 0,
          initialDelay: 1000,
          maxDelay: 600000
        })
      })
      .on('error', err => ee.emit('error', err))

    const source = db.streamChecksToUpdate({ live: true, keys: false })
    pump(
      source,
      checker,
      through.obj(function (data, enc, cb) {
        // drain
        myDebug(`updated check ${data.input.id}`)
        cb()
      })
    )

    return source.end.bind(source)
  }

  const updateCheck = co(function* updateCheck ({ id, document }) {
    let check
    try {
      check = yield api.checks.get({ checkId: id, expandReports: true })
    } catch (err) {
      myDebug('skipping for now, failed to get check', id, err)
      throw err
    }

    const putCheck = db.storeOnfidoResource(omit(check, ['reports']))
    const putReports = check.reports.map(r => db.storeOnfidoResource(r))
    const append = changes.appendAsync({
      topic: topics.checkupdate,
      document: document,
      status: status.check.complete,
      result: check.result
    })

    myDebug(`report completed for document ${document}: ${check.result}`)
    yield Promise.all([
      putCheck,
      putReports,
      append
    ])

    return check
  })

  function callbackify (promiseFn) {
    return co(function* (input) {
      const cb = arguments[arguments.length - 1]
      try {
        var ret = yield promiseFn(input)
      } catch (err) {
        myDebug('experienced error', err)
        return cb()
      }

      return cb(null, ret)
    })
  }

  const addPersonalInfo = co(function* addPersonalInfo (data) {
    let personalInfo
    try {
      personalInfo = yield keeper.getAsync(data.personalInfo)
    } catch (err) {
      myDebug('skipping, failed to get personal info for applicant', data)
      // err.skip = true
      throw err
    }

    data.personalInfo = {
      link: data.personalInfo,
      object: personalInfo
    }

    return data
  })

  const createOrUpdateApplicant = co(function* createOrUpdateApplicant ({ applicant, personalInfo, id }) {
    const data = convert.toOnfido(personalInfo.object)
    let onfidoApplicant
    try {
      if (id) {
        onfidoApplicant = yield api.applicants.update(id, data)
      } else {
        onfidoApplicant = yield api.applicants.create(data)
      }
    } catch (err) {
      if (err.message.indexOf('already entered this applicant') !== -1) {
        if (!id) {
          const saved = yield db.getApplicant(applicant)
          id = saved.id
        }

        if (id) {
          return db.getOnfidoResource(id)
        }

        // unclear what to do here as this means the applicant was not saved
        // and now we don't have a mapping for them
        //
        // a fallback could be to call onfido for a list of applicants and match
        // the results by personalInfo first_name/last_name/email
      }

      throw err
    }

    const put = db.storeOnfidoResource(onfidoApplicant)
    const append = changes.appendAsync({
      topic: topics.applicant,
      status: status.applicant.uptodate,
      applicant: applicant,
      id: onfidoApplicant.id
    })

    try {
      yield Promise.all([append, put])
    } catch (err) {
      // err.skip = true
      throw err
    }

    return onfidoApplicant
  })

  const addBody = co(function* addBody (data, prop='link') {
    const link = data[prop]
    let object
    try {
      data.object = yield keeper.getAsync(link)
    } catch (err) {
      myDebug('skipping, failed to get document', link)
      // err.skip = true
      throw err
    }

    return data
  })

  /**
   * upload a document and create a check for it
   * @param {[type]}   options.applicant [description]
   * @param {[type]}   options.link      [description]
   * @param {[type]}   options.object    [description]
   * @param {Function} cb
   */
  const uploadDocument = co(function* uploadDocument ({ applicant, link, object }) {
    const converted = convert.toOnfido(object)
    const applicantInfo = yield db.getApplicant(applicant)
    const { id } = applicantInfo
    if (!id) throw new Error('create an applicant before uploading documents!')

    myDebug(`uploading document for applicant ${id}`)
    const document = yield api.applicants.uploadDocument(id, converted)
    const putDoc = db.storeOnfidoResource(document)
    const append = changes.appendAsync({
      topic: topics.document,
      status: status.document.uploaded,
      applicant,
      link,
      // type: object[TYPE],
      id: document.id
    })

    yield Promise.all([
      append,
      putDoc
    ])

    return document
  })

  const uploadFace = co(function* uploadFace ({ applicant, link, object }) {
    const applicantInfo = yield db.getApplicant(applicant)
    const { id } = applicantInfo
    if (!id) throw new Error('create an applicant before uploading live photos!')

    myDebug(`uploading live photo for applicant ${id}`)
    const result = yield api.applicants.uploadLivePhoto(id, convert.toOnfidoPhoto(object))
    yield changes.appendAsync({
      topic: topics.face,
      faceId: result.id,
      link,
      status: status.face.uploaded
    })

    return result
  })

  const createCheck = co(function* createCheck ({ applicant, document, face }) {
    // const check = yield api.checks.createDocumentCheck(id)
    const reports = [{ name: 'document' }]
    // if (isPhotoID(converted.document_type)) {
    if (face) {
      reports.push({ name: 'facial_similarity' })
    }

    myDebug(`creating check for applicant "${applicant}", document "${document}"`)
    const check = yield api.checks.create(applicant, { reports })
    const append = changes.appendAsync({
      topic: topics.check,
      id: check.id,
      status: getCheckStatus(check),
      result: check.result,
      docReport: getReportId(check, 'document'),
      faceReport: getReportId(check, 'facial_similarity'),
      applicant,
      document,
      face
    })

    const putCheck = db.storeOnfidoResource(omit(check, ['reports']))
    const putReports = check.reports.map(r => db.storeOnfidoResource(r))
    yield Promise.all([
      append,
      putCheck,
      putReports
    ])

    return check
  })

  function manageWebhooks () {
    const checker = createRetryStream({
        worker: callbackify(updateWebhook),
        primaryKey: 'url',
        backoff: backoff.exponential({
          randomisationFactor: 0,
          initialDelay: 1000,
          maxDelay: 600000
        })
      })
      .on('error', err => ee.emit('error', err))

    const reg = db.streamWebhooksToRegister({ live: true, keys: false })
    const unreg = db.streamWebhooksToUnregister({ live: true, keys: false })
    pump(
      reg,
      checker,
      through.obj(function (data, enc, cb) {
        // drain
        myDebug(`registered webhook with onfido`)
        cb()
      })
    )

    pump(
      unreg,
      checker,
      through.obj(function (data, enc, cb) {
        // drain
        myDebug(`unregistered webhook with onfido`)
        cb()
      })
    )

    return function () {
      reg.end()
      unreg.end()
    }
  }

  const updateWebhook = co(function* updateWebhook (data) {
    const { url, events } = data
    let result
    switch (data.status) {
      case status.webhook.registerqueued: {
        result = yield api.registerWebhook({ url, events })
        yield changes.appendAsync({
          topic: topics.registeredwebhook,
          status: status.webhook.registered,
          id: result.id,
          url
        })

        break
      }
      case status.webhook.unregisterqueued: {
        result = yield api.unregisterWebhook(url)
        yield changes.appendAsync({
          topic: topics.unregisteredwebhook,
          status: status.webhook.unregistered,
          id: result.id,
          url
        })

        break
      }
    }

    return result
  })

  const ee = new EventEmitter()
  createAndUpdateApplicants()
  uploadDocuments()
  uploadFaces()
  createChecks()
  updateChecks()
  manageWebhooks()
  return ee
}

// function isPhotoID (onfidoType) {
//   switch (onfidoType) {
//   case 'passport':
//   case 'driving_licence':
//   case 'national_identity_card':
//     return true
//   case 'unknown'
//     return
//   default:
//     return false
//   }
// }

function getReportId (check, name) {
  const report = check.reports.find(r => r.name === name)
  return report && report.id
}
