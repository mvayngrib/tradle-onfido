
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
const getDocumentStatus = status.getDocumentStatus
const tradleToOnfidoType = require('./typemap')
const convert = require('./convert')
const DEV = require('./dev')

// const CHECK_OPTS = DEV
//   ? { reports: [{ name: 'document' }] }
//   : { reports: [{ name: 'document', consider: false }] }

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

  function checkDocuments () {
    // const creator = createRetryStream({
    //     worker: checkDocument,
    //     primaryKey: 'link',
    //     backoff: newBackoff()
    //   })
    //   .on('error', err => ee.emit('error', err))

    const source = db.streamDocumentsToCreate({ live: true, keys: false })
    pump(
      source,
      through.obj(callbackify(addDocument)),
      through.obj(callbackify(checkDocument)),
      through.obj(function ({ document, check, reports }, enc, cb) {
        // drain
        myDebug(`uploaded document ${document.id} to onfido`)
        cb()
      })
    )

    return source.end.bind(source)
  }

  function checkReports () {
    const checker = createRetryStream({
        worker: callbackify(getReport),
        primaryKey: 'link',
        backoff: backoff.exponential({
          randomisationFactor: 0,
          initialDelay: 1000,
          maxDelay: 600000
        })
      })
      .on('error', err => ee.emit('error', err))

    const source = db.streamDocumentsToCheck({ live: true, keys: false })
    pump(
      source,
      checker,
      through.obj(function (data, enc, cb) {
        // drain
        myDebug(`updated report ${data.report} from onfido`)
        cb()
      })
    )

    return source.end.bind(source)
  }

  const getReport = co(function* getReport (doc) {
    let report
    try {
      report = yield api.reports.get(doc.report)
    } catch (err) {
      myDebug('skipping for now, failed to get report', doc.report, err)
      throw err
    }

    const update = db.updateOnfidoResource(report)
    const append = changes.appendAsync({
      topic: topics.documentstatus,
      link: doc.link,
      report: report.id,
      status: status.document.complete,
      // result: DEV ? doc.result : report.result
      result: report.result
    })

    myDebug(`report completed for document ${doc.link}: ${report.result}`)
    yield Promise.all([update, append])
    return update
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

  const addDocument = co(function* addDocument (data) {
    const { link } = data
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
  const checkDocument = co(function* checkDocument ({ applicant, link, object }) {
    const converted = convert.toOnfido(object)
    try {
      const applicantInfo = yield db.getApplicant(applicant)
      const { id } = applicantInfo
      if (!id) throw new Error('create an applicant before uploading documents!')

      const document = yield api.applicants.uploadDocument(id, converted)
      const check = yield api.checks.createDocumentCheck(id)
      // const check = yield api.checks.create(id, { reports: [{ name: 'document' }] })
      // if (DEV) {
      //   check.result = 'clear'
      //   check.reports.forEach(r => r.result = 'clear')
      // }

      const putDoc = db.storeOnfidoResource(document)
      const putCheck = db.storeOnfidoResource(omit(check, ['reports']))
      const putReports = check.reports.map(r => db.storeOnfidoResource(r))
      const append = changes.appendAsync({
        topic: topics.document,
        applicant,
        link,
        // type: object[TYPE],
        id: document.id,
        status: getDocumentStatus(check),
        result: check.result,
        check: check.id,
        report: check.reports.find(r => r.name === 'document').id
      })

      yield Promise.all([
        append,
        putDoc,
        putCheck,
        Promise.all(putReports)
      ])

      return { document, check, reports: check.reports }
    } catch (err) {
      // err.skip = true
      throw err
    }
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
  checkDocuments()
  checkReports()
  manageWebhooks()
  return ee
}
