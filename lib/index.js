
const typeforce = require('typeforce')
const debug = require('debug')('tradle:onfido')
const Promise = require('bluebird')
const co = Promise.coroutine
const createProcessor = require('./processor')
const createDB = require('./db')
const topics = require('./topics')
const status = require('./status')
const getDocumentStatus = status.getDocumentStatus

module.exports = createClient

function createClient (opts) {
  typeforce({
    path: typeforce.String,
    api: typeforce.Object,
    node: typeforce.Object
  }, opts)

  const { path, api, node } = opts
  let { keeper, changes } = node
  const db = createDB({ path, node })
  const processor = createProcessor({ api, changes, keeper, db })

  changes = Promise.promisifyAll(changes)
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
        applicant,
        link
      })
    },
    checkFace: function (opts) {
      typeforce({
        applicant: typeforce.String,
        selfie: typeforce.String
      }, opts)

      const { applicant, selfie } = opts
      return changes.appendAsync({
        topic: topics.queueface,
        applicant,
        selfie
      })
    },
    processEvent: co(function* (req, res) {
      let event
      try {
        event = yield webhooks.handleEvent(req)
      } catch (err) {
        debug(err)
        return res.status(500).end()
      }

      const { resource_type, action, object } = event

      try {
        let entry
        switch (resource_type) {
          case 'report': {
            if (action === 'report.completed') {
              const id = object.id
              const doc = yield db.getDocumentByReportId(id)
              entry = {
                topic: topics.documentstatus,
                link: doc.link,
                report: id,
                status: getDocumentStatus(object)
              }
            }

          }
          case 'check': {

          }
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
    db: db,
    api: api,
    close: co(function* () {
      return db.close()
    })
  }
}
