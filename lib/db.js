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

  // const myDebug = utils.subdebugger(debug, opts.name || node.permalink.slice(0, 6))
  const ee = new EventEmitter()
  const dbs = {}
  const indexes = {
    applicants: {},
    documents: {},
    faces: {},
    checks: {},
    webhooks: {}
  }

  Object.keys(indexes).forEach(p => {
    dbs[p] = createDB(p)
    dbs[p].once('closing', () => closed = true)
  })

  const applicants = indexer({
    feed: changes,
    db: dbs.applicants,
    primaryKey: 'applicant',
    filter: ({ topic }) => {
      return topic === topics.queueapplicant || topic == topics.applicant || topic === topics.updateapplicant
    },
    reduce: function (state, change, cb) {
      const changeVal = change.value
      const topic = changeVal.topic

      if (topic === topics.queueapplicant && state) {
        return cb(null, state)
      }

      const newState = applicants.merge(state, change)
      delete newState.topic
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
    db: dbs.documents,
    primaryKey: 'link',
    filter: ({ topic }) => {
      return topic === topics.queuedocument || topic === topics.document
    },
    reduce: function (state, change, cb) {
      const newState = documents.merge(state, change)
      delete newState.topic
      cb(null, newState)
    }
  })

  documents.on('change', function (change, newState, oldState) {
    switch (change.value.topic) {
    case topics.queuedocument:
      return ee.emit('document:queued', newState)
    case topics.document:
      return ee.emit('document:uploaded', newState)
    }
  })

  ;['id', 'applicant', 'status'].forEach(prop => {
    indexes.documents[prop] = documents.by(prop, state => {
      return state[prop] + sep + state.link
    })
  })

  indexes.documents.latest = documents.by('latest', state => {
    if (state.status === status.document.uploaded) {
      // overwrite every time
      return state.applicant + sep + state.applicant
    }
  })

  const faces = indexer({
    feed: changes,
    db: dbs.faces,
    primaryKey: 'link',
    filter: val => val.topic === topics.queueface || val.topic === topics.face,
    reduce: function (state, change, cb) {
      const newState = faces.merge(state, change)
      delete newState.topic
      cb(null, newState)
    }
  })

  indexes.faces.status = faces.by('status', function (state) {
    return state.status + sep + state.applicant + sep + state.link
  })

  faces.on('change', function (change, newState, oldState) {
    if (change.value.topic === topics.face) {
      return ee.emit('face:uploaded', newState)
    }
  })

  const checks = indexer({
    feed: changes,
    db: dbs.checks,
    primaryKey: 'document',
    filter: val => {
      return val.topic === topics.queuecheck || val.topic === topics.check || val.topic === topics.checkupdate
    },
    reduce: function (state, change, cb) {
      const newState = checks.merge(state, change)
      delete newState.topic
      cb(null, newState)
    }
  })

  indexes.checks.status = checks.by('status', function (state) {
    return state.status + sep + state.document
  })

  ;['result', 'docReport', 'faceReport', 'applicant', 'document', 'face', 'id'].forEach(prop => {
    indexes.checks[prop] = checks.by(prop, state => {
      if (state[prop]) {
        return state[prop] + sep + state.document
      }
    })
  })

  // indexes.checks.latest = checks.by('latest', state => {
  //   if (state.status === status.check.new) {
  //     // overwrite every time
  //     return state.applicant + sep + state.applicant
  //   }
  // })

  indexes.checks.statusForApplicant = checks.by('statusForApplicant', state => {
    return state.applicant + sep + state.status + sep + state.document
  })

  checks.on('change', function (change, newState, oldState) {
    const topic = change.value.topic
    if (topic === topics.check) {
      return ee.emit('check:created')
    }

    // just completed
    const justCompleted = oldState &&
        oldState.status !== status.check.complete &&
        newState.status === status.check.complete

    if (justCompleted) {
      ee.emit('check:complete', newState)
      // if (newState.result === 'clear') {
      //   return ee.emit('document:verified', newState)
      // } else if (newState.result === 'consider') {
      //   return ee.emit('document:consider', newState)
      // }
    }
  })

  const webhooks = indexer({
    feed: changes,
    db: dbs.webhooks,
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

  const getPendingCheck = co(function* getPendingCheck (applicant) {
    typeforce(typeforce.String, applicant)

    const checks = yield collect(indexes.checks.statusForApplicant.createReadStream({
      keys: false,
      gte: applicant + sep + status.check.new,
      lt: applicant + sep + status.check.complete,
    }))

    if (!checks.length) throw new Error('no pending checks')

    return checks[0]
  })

  const getLatestDocument = co(function* getLatestDocument (applicant) {
    typeforce(typeforce.String, applicant)

    const docs = yield collect(indexes.documents.latest.createReadStream({
      keys: false,
      eq: applicant
    }))

    if (!docs.length) throw new Error('no documents uploaded')

    return docs[0]
  })

  const getDocumentByReportId = co(function* getDocumentByReportId (id) {
    typeforce(typeforce.String, id)

    const results = yield collect(indexes.checks.docReport.createReadStream({
      keys: false,
      eq: id
    }))

    if (!results.length) throw new Error('document not found')

    return results.pop()
  })

  const getCheckById = co(function* getCheckById (id) {
    typeforce(typeforce.String, id)

    const results = yield collect(indexes.checks.id.createReadStream({
      keys: false,
      eq: id
    }))

    if (!results.length) throw new Error('document not found')

    return results.pop()
  })

  const getLatestFace = co(function* getLatestFace (applicant) {
    typeforce(typeforce.String, applicant)

    const results = yield collect(indexes.faces.status.createReadStream({
      keys: false,
      eq: status.face.uploaded + sep + applicant
    }))

    if (!results.length) throw new Error('no face found')

    return results.pop()
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

  function streamFacesToUpload (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.face.new
    return indexes.faces.status.createReadStream(opts)
  }

  function streamDocumentsToCreate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.document.new
    return indexes.documents.status.createReadStream(opts)
  }

  // function streamDocumentsToCheck (opts={}) {
  //   if (!('keys' in opts)) opts.keys = false

  //   opts.eq = status.document.checked
  //   return indexes.documents.status.createReadStream(opts)
  // }

  function streamVerifiedChecks (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = 'clear'
    return indexes.checks.result.createReadStream(opts)
  }

  function streamFailedChecks (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = 'consider'
    return indexes.checks.result.createReadStream(opts)
  }

  function streamChecksToCreate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.check.new
    return indexes.checks.status.createReadStream(opts)
  }

  function streamChecksToUpdate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.check.checked
    return indexes.checks.status.createReadStream(opts)
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

    return closePromise = Promise.all(
      Object.keys(dbs).map(name => dbs[name].close())
    )
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
    streamFacesToUpload,
    streamDocumentsToCreate,
    // streamDocumentsToCheck,
    streamVerifiedChecks,
    streamFailedChecks,
    streamChecksToCreate,
    streamChecksToUpdate,
    streamWebhooksToRegister,
    streamWebhooksToUnregister,
    getApplicant,
    getDocument,
    getLatestDocument,
    getDocumentByReportId,
    getCheckById,
    getLatestFace,
    getPendingCheck,
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
