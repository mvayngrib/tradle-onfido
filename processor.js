
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

module.exports = function processor (opts) {
  let { api, db, changes, keeper } = opts
  changes = Promise.promisifyAll(changes)
  keeper = Promise.promisifyAll(keeper)
  const myDebug = debug // tradle.utils.subdebugger()

  function createApplicants () {
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

    const source = db.streamApplicantsToCreate({ live: true, keys: false })
    pump(
      source,
      through.obj(addPersonalInfo),
      through.obj(createApplicant),
      through.obj(function (data, enc, cb) {
        // drain
        myDebug(`created onfido applicant with id: ${data.id}`)
        cb()
      })
    )

    return source.end.bind(source)
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
      through.obj(addDocument),
      through.obj(checkDocument),
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
        worker: getReport,
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

  const getReport = co(function* (doc, cb) {
    let report
    try {
      report = yield api.reports.get(doc.report)
    } catch (err) {
      myDebug('skipping for now, failed to get report', doc.report, err)
      return cb(err)
    }

    const update = db.updateOnfidoResource(report)
    const append = changes.appendAsync({
      topic: topics.documentstatus,
      link: doc.link,
      report: report.id,
      status: status.document.complete,
      result: report.result
    })

    myDebug(`report completed for document ${doc.link}: ${report.result}`)
    yield Promise.all([update, append])
    return update
  })

  const addPersonalInfo = co(function* addPersonalInfo (data, enc, cb) {
    let personalInfo
    try {
      personalInfo = yield keeper.getAsync(data.personalInfo)
    } catch (err) {
      myDebug('skipping, failed to get personal info for applicant', data)
      return cb()
    }

    data.personalInfo = {
      link: data.personalInfo,
      object: personalInfo
    }

    cb(null, data)
  })

  const createApplicant = co(function* createApplicant ({ applicant, personalInfo }, enc, cb) {
    const data = personalInfoToOnfidoApplicant(personalInfo)
    const onfidoApplicant = yield api.applicants.createApplicant(data)
    const put = db.storeOnfidoResource(onfidoApplicant)
    const append = changes.appendAsync({
      topic: topics.applicant,
      applicant: applicant,
      id: onfidoApplicant.id
    })

    try {
      yield Promise.all([append, put])
    } catch (err) {
      err.skip = true
      return cb(err)
    }

    cb(null, onfidoApplicant)
  })

  const addDocument = co(function* addDocument (data, enc, cb) {
    const { link } = data
    let object
    try {
      data.object = yield keeper.getAsync(link)
    } catch (err) {
      myDebug('skipping, failed to get document', link)
      return cb()
    }

    cb(null, data)
  })

  /**
   * upload a document and create a check for it
   * @param {[type]}   options.applicant [description]
   * @param {[type]}   options.link      [description]
   * @param {[type]}   options.object    [description]
   * @param {Function} cb
   */
  const checkDocument = co(function* checkDocument ({ applicant, link, object }, enc, cb) {
    const { id } = yield db.getApplicant(applicant)
    const document = yield api.applicants.uploadDocument(toOnfidoDocument(object))
    const check = yield api.checks.createDocumentCheck(id)
    const putDoc = db.storeOnfidoResource(document)
    const putCheck = db.storeOnfidoResource(omit(check, ['reports']))
    const putReports = check.reports.map(r => db.storeOnfidoResource(r))
    const append = changes.appendAsync({
      topic: topics.document,
      link: link,
      id: document.id,
      status: getDocumentStatus(check),
      result: check.result,
      check: check.id,
      report: check.reports[0].id
    })

    try {
      yield Promise.all([
        append,
        putDoc,
        putCheck,
        Promise.all(putReports)
      ])
    } catch (err) {
      err.skip = true
      return cb(err)
    }

    const result = { document, check, reports: check.reports }
    cb(null, result)
    return result
  })

  const ee = new EventEmitter()
  createApplicants()
  checkDocuments()
  checkReports()
  return ee
}

function personalInfoToOnfidoApplicant (personalInfo) {
  // TODO: get telephone, addresses, etc.
  return {
    first_name: personalInfo.firstName,
    last_name: personalInfo.lastName,
    email: personalInfo.emailAddress,
  }
}

function dataUriToBuffer (uri) {
  const idx = uri.indexOf('base64,')
  return new Buffer(uri.slice(idx + 7), 'base64')
}

function toOnfidoDocument (doc) {
  const type = tradleToOnfidoType[doc[TYPE]]
  if (!type) throw new Error('unsupported document type: ' + doc[TYPE])
  return {
    type: type,
    file: dataUriToBuffer(doc.photos[0].url)
  }
}
