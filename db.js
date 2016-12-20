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
    node: typeforce.Object,
    db: typeforce.String
  }, opts)

  let closed
  let closePromise
  const node = opts.node
  const keeper = Promise.promisifyAll(node.keeper)
  const changes = node.changes
  const applicantsDB = createDB('onfido-applicants')
  applicantsDB.once('closing', () => closed = true)

  const documentsDB = createDB('onfido-documents')
  documentsDB.once('closing', () => closed = true)

  const reportsDB = createDB('onfido-reports')
  reportsDB.once('closing', () => closed = true)

  // const webhooksDB = node._createDB('onfido-webhooks-' + opts.db)
  // webhooksDB.once('closing', () => closed = true)

  node.once('destroying', close)

  // const myDebug = utils.subdebugger(debug, opts.name || node.permalink.slice(0, 6))
  const ee = new EventEmitter()
  const indexes = {
    applicants: {},
    documents: {}
  }

  const applicants = indexer({
    feed: changes,
    db: applicantsDB,
    primaryKey: 'applicant',
    filter: ({ topic }) => {
      return topic === topics.queueapplicant || topic == topics.applicant
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
          newState.id = changeVal.id
          newState.status = status.applicant.created
          break
        }
      }

      cb(null, newState)
    }
  })

  const sep = applicants.separator
  ;['status', 'id'].forEach(prop => {
    indexes.applicants[prop] = applicants.by(prop, val => {
      return val[prop] + sep + val.applicant
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
          newState = utils.clone(state)
          newState.id = changeVal.id
          newState.status = status.document.created
          break
        }
        case topics.documentstatus: {
          newState = utils.clone(state)
          newState.report = changeVal.report
          newState.status = changeVal.status
          newState.result = changeVal.result
          break
        }
      }

      cb(null, newState)
    }
  })

  documents.on('change', function (change, newState, oldState) {
    switch (change.value.topic) {
    case topics.queuedocument:
      return ee.emit('document:queue', newState)
    case topics.document:
      return ee.emit('document:create', newState)
    case topics.documentstatus:
      if (newState.result === 'clear') {
        return ee.emit('document:verified', newState)
      } else if (newState.result === 'consider') {
        return ee.emit('document:consider', newState)
      }
    }
  })

  ;['status', 'result', 'id'].forEach(prop => {
    indexes.documents[prop] = documents.by(prop, val => {
      return val[prop] + sep + val.link
    })
  })

  function getApplicant (permalink) {
    return applicants.getAsync(permalink)
  }

  function getDocument (link) {
    return documents.getAsync(link)
  }

  const getPendingDocument = co(function* getPendingDocument (applicant) {
    const results = yield collect(indexes.documents.status.createReadStream({
      keys: false,
      gte: status.document.created,
      lt: status.document.checked
    }))

    return results[0]
  })

  function getApplicantsToCreate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.applicant.new
    return indexes.applicants.status.createReadStream(opts)
  }

  function getDocumentsToCreate (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.document.new
    return indexes.documents.status.createReadStream(opts)
  }

  function getDocumentsToCheck (opts={}) {
    if (!('keys' in opts)) opts.keys = false

    opts.eq = status.document.checked
    return indexes.documents.status.createReadStream(opts)
  }

  function close () {
    if (closePromise) return closePromise

    return closePromise = Promise.all([
      applicantsDB.close(),
      documentsDB.close(),
      reportsDB.close(),
      // done => webhooksDB.close(done)
    ])
    .finally(() => closed => true)
  }

  function createDB (name) {
    const db = node._createDB(name + '-' + opts.db)
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
    getApplicantsToCreate,
    getDocumentsToCreate,
    getDocumentsToCheck,
    getApplicant,
    getDocument,
    getPendingDocument,
    storeOnfidoResource,
    updateOnfidoResource,
    getOnfidoResource
  })
}

function onfidoResourceKey (resourceOrId) {
  const id = resourceOrId.id || resourceOrId
  typeforce(typeforce.String, id)
  return 'onfido:' + id
}
