
const typeforce = require('typeforce')
const debug = require('debug')('tradle:onfido')
const Promise = require('bluebird')
const co = Promise.coroutine
const createProcessor = require('./processor')
const createDB = require('./db')
const topics = require('./topics')
const status = require('./status')
const getCheckStatus = status.getCheckStatus
const DEV = require('./dev')

module.exports = createClient

function createClient (opts) {
  typeforce({
    path: typeforce.String,
    api: typeforce.Object,
    changes: typeforce.Object,
    keeper: typeforce.Object,
    leveldown: typeforce.Function
  }, opts)

  let { path, api, keeper, changes, leveldown } = opts
  changes = Promise.promisifyAll(changes)
  keeper = Promise.promisifyAll(keeper)

  const db = createDB({ path, keeper, changes, leveldown })
  const processor = createProcessor({ api, changes, keeper, db })

  // processor = Promise.promisifyAll(processor)
  const { webhooks } = api
  return {
    createApplicant: function (opts) {
      typeforce({
        applicant: typeforce.String,
        personalInfo: typeforce.String
      }, opts)

      const { applicant, personalInfo } = opts
      return changes.appendAsync({
        topic: topics.queueapplicant,
        status: status.applicant.new,
        applicant,
        personalInfo
      })
    },
    updateApplicant: function (opts) {
      typeforce({
        applicant: typeforce.String,
        personalInfo: typeforce.String
      }, opts)

      const { applicant, personalInfo } = opts
      return changes.appendAsync({
        topic: topics.updateapplicant,
        status: status.applicant.updating,
        applicant,
        personalInfo
      })
    },
    checkDocument: function (opts) {
      typeforce({
        applicant: typeforce.String,
        link: typeforce.String
      }, opts)

      const { applicant, link } = opts
      return changes.appendAsync({
        topic: topics.queuedocument,
        status: status.document.new,
        applicant,
        link
      })
    },
    checkFace: co(function* (opts) {
      typeforce({
        applicant: typeforce.String,
        link: typeforce.String
      }, opts)

      const { applicant, link } = opts
      return changes.appendAsync({
        topic: topics.queueface,
        status: status.face.new,
        applicant,
        link
      })
    }),
    getLatestFace: co(function* (opts) {
      return db.getLatestFace(opts.applicant)
    }),
    getLatestDocument: co(function* (opts) {
      return db.getLatestDocument(opts.applicant)
    }),
    checkAgainstLatestData: co(function* (opts) {
      const { applicant, checkFace=true } = opts
      const getPending = db.getPendingCheck(applicant)
      const tasks = [
        db.getLatestDocument(applicant)
      ]

      if (checkFace) {
        tasks.push(db.getLatestFace(applicant))
      }

      try {
        yield getPending
        throw new Error('a check is already pending')
      } catch (err) {}

      const [doc, face] = yield Promise.all(tasks)
      const entry = {
        topic: topics.queuecheck,
        applicant,
        document: doc.link,
        status: status.check.new
      }

      if (checkFace) entry.face = face.link

      return changes.appendAsync(entry)
    }),
    processEvent: co(function* (req, res, desiredResult) {
      let event
      try {
        event = yield webhooks.handleEvent(req)
      } catch (err) {
        debug(err)
        return res.status(500).end()
      }

      const { resource_type, action, object } = event
      if (DEV && desiredResult) object.result = desiredResult

      try {
        let entry
        switch (resource_type) {
          // case 'report': {
          //   if (action === 'report.completed') {
          //     let id = object.id
          //     let doc = yield db.getDocumentByReportId(id)

          //     entry = {
          //       topic: topics.documentstatus,
          //       link: doc.link,
          //       report: id,
          //       status: getCheckStatus(object)
          //     }
          //   }
          // }
          case 'check': {
            if (action === 'check.completed') {
              let id = object.id
              let check = yield db.getCheckById(id)
              entry = {
                topic: topics.checkupdate,
                document: check.document,
                status: getCheckStatus(object),
                result: object.result
              }
            }
          }
          // case 'check': {
          //   if (action === 'check.completed') {
          //     const { reports } = yield db.getOnfidoResource(object.id)
          //     const docReport = reports.find(r => r.name === 'document')
          //     const doc = yield db.getDocumentByReportId(id)
          //     entry = {
          //       topic: topics.documentstatus,
          //       link: doc.link,
          //       report: id,
          //       status: getCheckStatus(object)
          //     }
          //   }
          // }
        }

        const promises = [
          db.updateOnfidoResource(object)
        ]

        if (entry) {
          promises.push(changes.appendAsync(entry))
        }

        yield Promise.all(promises)
      } catch (err) {
        debug(err)
        return res.status(500).end()
      }

      res.status(200).end()
    }),

    registerWebhook: function registerWebhook ({ url, events }) {
      return changes.appendAsync({
        topic: topics.registerwebhook,
        status: status.webhook.registerqueued,
        url,
        events
      })
    },

    unregisterWebhook: function unregisterWebhook (url) {
      return changes.appendAsync({
        topic: topics.unregisterwebhook,
        status: status.webhook.unregisterqueued,
        url
      })
    },

    getOnfidoResource: function (id) {
      return db.getOnfidoResource(id)
    },
    close: co(function* () {
      return db.close()
    }),
    changes,
    keeper,
    db,
    api
  }
}
