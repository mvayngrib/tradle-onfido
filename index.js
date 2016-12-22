
const typeforce = require('typeforce')
const debug = require('debug')('tradle:onfido')
const Promise = require('bluebird')
const co = Promise.coroutine
const createProcessor = require('./processor')
const createDB = require('./db')
const topics = require('./topics')
const status = require('./status')
const getDocumentStatus = status.getDocumentStatus

module.exports = function actions (opts) {
  typeforce({
    db: typeforce.String,
    api: typeforce.Object,
    node: typeforce.Object
  }, opts)

  const node = opts.node
  let { keeper, changes } = node
  const db = createDB({
    db: opts.db,
    node: node
  })

  const processor = createProcessor({
    api: opts.api,
    changes: changes,
    keeper: keeper,
    db: db
  })

  changes = Promise.promisifyAll(changes)
  const { webhooks } = opts.api
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

    registerWebhook: co(function* registerWebhook ({ url, events }) {
      return yield webhooks.register({ url, events })
      // const webhook = yield webhooks.register({ url, events })
      // const put = keep(webhook)
      // const append changes.appendAsync({
      //   topic: topics.registerwebhook,
      //   id: webhook.id
      // })

      // return Promise.all([put, append])
    }),

    unregisterWebhook: co(function* unregisterWebhook (url) {
      return yield webhooks.unregister(url)
      // const webhook = yield webhooks.unregister(url)
      // const put = keep(webhook)
      // const append changes.appendAsync({
      //   topic: topics.unregisterwebhook,
      //   id: webhook.id
      // })

      // return Promise.all([put, append])
    }),

    getOnfidoResource: function (id) {
      return db.getOnfidoResource(id)
    },
    db: db,
    close: co(function* () {
      return db.close()
    })
  }
}
