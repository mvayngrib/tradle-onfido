const path = require('path')
const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const rawIndexer = require('feed-indexer')
const deepExtend = require('deep-extend')
const debug = require('debug')('tradle:dbs:onfido')
const Promise = require('bluebird')
const co = Promise.coroutine
const collect = Promise.promisify(require('stream-collector'))
const indexer = function (opts) {
  return Promise.promisifyAll(rawIndexer(opts))
}

const { utils, constants } = require('@tradle/engine')
const { ENTRY_PROP } = constants
const topics = require('./topics')
const status = require('./status')

module.exports = function onfido (opts) {
  typeforce({
    changes: typeforce.Object,
    keeper: typeforce.Object,
    path: typeforce.String,
    leveldown: typeforce.maybe(typeforce.Function)
  }, opts)

  let closed
  let closePromise
  const keeper = Promise.promisifyAll(opts.keeper)
  const changes = opts.changes
  const applicantsDB = createDB('applicants')
  applicantsDB.once('closing', () => closed = true)

  const documentsDB = createDB('documents')
  documentsDB.once('closing', () => closed = true)

  // const reportsDB = createDB('reports')
  // reportsDB.once('closing', () => closed = true)

  const webhooksDB = createDB('webhooks')
  webhooksDB.once('closing', () => closed = true)

  // const myDebug = utils.subdebugger(debug, opts.name || node.permalink.slice(0, 6))
  const ee = new EventEmitter()
  const indexes = {
    applicants: {},
    documents: {},
    webhooks: {}
  }

  const applicants = indexer({
    feed: changes,
    db: applicantsDB,
    primaryKey: 'applicant',
    filter: ({ topic }) => {
      return topic === topics.queueapplicant || topic == topics.applicant || topic === topics.updateapplicant
    },
    reduce: function (state, change, cb) {
      let newState
      const changeVal = change.value
      const topic = changeVal.topic

      switch (topic) {
        case topics.queueapplicant: {
          newState = utils.pick(changeVal, 'applicant', 'personalInfo')
          newState.status = status.applicant.new
          break
        }
        case topics.applicant: {
          newState = utils.clone(state)
          newState.status = status.applicant.uptodate
          if (!newState.id) newState.id = changeVal.id
          break
        }
        case topics.updateapplicant: {
          newState = utils.clone(state)
          newState.status = status.applicant.updating
          break
        }
      }

      cb(null, newState)
    }
  })

  const sep = applicants.separator
  ;['status', 'id'].forEach(prop => {
    indexes.applicants[prop] = applicants.by(prop, state => {
      return state[prop] + sep + state.applicant
    })
  })

  applicants.on('change', function (change, newState, oldState) {
    switch (change.value.topic) {
    case topics.queueapplicant:
      return ee.emit('applicant:queue', newState)
    case topics.applicant:
      return ee.emit('applicant:create', newState)
    }
  })

  const documents = indexer({
    feed: changes,
    db: documentsDB,
    primaryKey: 'link',
    filter: ({ topic }) => {
      return topic === topics.queuedocument || topic == topics.document || topic === topics.documentstatus
    },
    reduce: function (state, change, cb) {
      let newState
      const changeVal = change.value
      const topic = changeVal.topic

      switch (topic) {
        case topics.queuedocument: {
          newState = utils.pick(changeVal, 'link', 'applicant')
          newState.status = status.document.new
          break
        }
        case topics.document: {
          newState = documents.merge(state, change)
          break
        }
        case topics.documentstatus: {
          newState = documents.merge(state, change)
          break
        }
      }

      delete newState.topic
      cb(null, newState)
    }
  })

  documents.on('change', function (change, newState, oldState) {
    switch (change.value.topic) {
    case topics.queuedocument:
      return ee.emit('document:queue', newState)
    case topics.document:
      ee.emit('document:create', newState)
      break
    }

    // just completed
    const justCompleted = oldState &&
        oldState.status !== status.document.complete &&
        newState.status === status.document.complete

    if (justCompleted) {
      ee.emit('document:complete', newState)
      // if (newState.result === 'clear') {
      //   return ee.emit('document:verified', newState)
      // } else if (newState.result === 'consider') {
      //   return ee.emit('document:consider', newState)
      // }
    }
  })

  ;['status', 'report', 'result', 'id'].forEach(prop => {
    indexes.documents[prop] = documents.by(prop, state => {
      return state[prop] + sep + state.link
    })
  })

  indexes.documents.statusForApplicant = documents.by('statusForApplicant', state => {
    return state.applicant + sep + state.status + sep + state.link
  })

  const webhooks = indexer({
    feed: changes,
    db: webhooksDB,
    primaryKey: 'url',
    filter: ({ topic }) => {
      return topic === topics.registerwebhook ||
            topic === topics.registeredwebhook ||
            topic === topics.unregisterwebhook ||
            topic === topics.unregisteredwebhook
    },
    reduce: function (state, change, cb) {
      const changeVal = change.value
      const { topic } = changeVal
      // already registered
      if (state && changeVal.status === state.status) return cb(null, state)

      switch (topic) {
        case topics.registerwebhook:
          if (state && state.status === status.webhook.registered) {
            // already registered
            return cb(null, state)
          }

          break
        case topics.unregisterwebhook:
          if (!state || state.status === status.webhook.unregistered) {
            // already unregistered
            return cb(null, state)
          }

          break
      }

      const newState = webhooks.merge(state, change)
      delete newState.topic
      cb(null, newState)
    }
  })

  ;['id', 'url', 'status'].forEach(prop => {
    indexes.webhooks[prop] = webhooks.by(prop, state => {
      return state[prop] + sep + state.url
    })
  })

  webhooks.on('change', function (change, newState, oldState) {
    switch (change.value.topic) {
    case topics.registeredwebhook:
      return ee.emit('webhook:register', newState)
    case topics.unregisteredwebhook:
      return ee.emit('webhook:unregister', newState)
    }
  })

  function getApplicant (permalink) {
    return applicants.getAsync(permalink)
  }

  function getDocument (link) {
    return documents.getAsync(link)
  }

  const getPendingDocument = co(function* getPendingDocument (applicant) {
    typeforce(typeforce.String, applicant)

    // console.log(applicant + sep + status.document.created)
    // console.log(applicant + sep + status.document.checked)
    const results = yield collect(indexes.documents.statusForApplicant.createReadStream({
      keys: false,
      gte: applicant + sep + status.document.created,
      lt: applicant + sep + status.document.checked
    }))

    return results[0]
  })

  const getDocumentByReportId = co(function* getDocumentByReportId (id) {
    typeforce(typeforce.String, id)

    const results = yield collect(indexes.documents.report.createReadStream({
      keys: false,
      eq: id
    }))

    return results[0]
  })

  function streamApplicantsToCreate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.applicant.new
    return indexes.applicants.status.createReadStream(opts)
  }

  function streamApplicantsToUpdate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.applicant.updating
    return indexes.applicants.status.createReadStream(opts)
  }

  function streamDocumentsToCreate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.document.new
    return indexes.documents.status.createReadStream(opts)
  }

  function streamDocumentsToCheck (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.document.checked
    return indexes.documents.status.createReadStream(opts)
  }

  function streamVerifiedDocuments (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = 'clear'
    return indexes.documents.result.createReadStream(opts)
  }

  function streamFailedDocuments (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = 'consider'
    return indexes.documents.result.createReadStream(opts)
  }

  function streamWebhooksToRegister (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.webhook.registerqueued
    return indexes.webhooks.status.createReadStream(opts)
  }

  function streamWebhooksToUnregister (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.webhook.unregisterqueued
    return indexes.webhooks.status.createReadStream(opts)
  }

  function getWebhooks () {
    return collect(webhooks.createReadStream({ keys: false }))
  }

  function close () {
    if (closePromise) return closePromise

    return closePromise = Promise.all([
      applicantsDB.close(),
      documentsDB.close(),
      // reportsDB.close(),
      webhooksDB.close()
    ])
    .finally(() => closed => true)
  }

  function createDB (name) {
    const levelOpts = {}
    if (opts.leveldown) levelOpts.db = opts.leveldown

    const db = utils.levelup(path.join(opts.path, name + '.db'), levelOpts)
    return Promise.promisifyAll(db)
  }

  const updateOnfidoResource = co(function* updateOnfidoResource (resource) {
    const saved = yield getOnfidoResource(resource.id)
    const updated = deepExtend(saved, resource)
    return storeOnfidoResource(updated)
  })

  const storeOnfidoResource = co(function* storeOnfidoResource (resource) {
    yield keeper.putAsync(onfidoResourceKey(resource), resource)
    return resource
  })

  function getOnfidoResource (id) {
    return keeper.getAsync(onfidoResourceKey(id))
  }

  return utils.extend(ee, {
    streamApplicantsToCreate,
    streamApplicantsToUpdate,
    streamDocumentsToCreate,
    streamDocumentsToCheck,
    streamVerifiedDocuments,
    streamFailedDocuments,
    streamWebhooksToRegister,
    streamWebhooksToUnregister,
    getApplicant,
    getDocument,
    getPendingDocument,
    getDocumentByReportId,
    storeOnfidoResource,
    updateOnfidoResource,
    getOnfidoResource,
    getWebhooks,
    close
  })
}

function onfidoResourceKey (resourceOrId) {
  const id = resourceOrId.id || resourceOrId
  typeforce(typeforce.String, id)
  return 'onfido:' + id
}
