
const path = require('path')
const PassThrough = require('stream').PassThrough
const { EventEmitter } = require('events')
const test = require('tape')
const Promise = require('bluebird')
const co = Promise.coroutine
const fs = Promise.promisifyAll(require('fs'))
const collect = Promise.promisify(require('stream-collector'))
const tradle = require('@tradle/engine')
const testHelpers = require('@tradle/engine/test/helpers')
const changesFeed = require('changes-feed')
const memdown = require('memdown')
const parseDataUri = require('parse-data-uri')
const Onfido = require('@tradle/onfido-api')
const createOnfidoDB = require('../db')
const status = require('../status')
const createOnfido = require('../')
const fixtures = {
  applicants: require('./fixtures/applicants'),
  checks: require('./fixtures/checks'),
  documents: require('./fixtures/documents'),
  documentImages: require('./fixtures/document-images')
}

// const keeper = Promise.promisifyAll(testHelpers.keeper())

const APPLICANT = fixtures.applicants[0]
const APPLICANT_NAME = APPLICANT.first_name
const PERSONAL_INFO_KEY = APPLICANT_NAME + '-personalInfo'
const DOC_KEY = APPLICANT_NAME + '-doc'
const putTestData = co(function* (keeper) {
  yield Promise.all([
    keeper.putAsync(APPLICANT_NAME, { name: APPLICANT_NAME }),
    keeper.putAsync(PERSONAL_INFO_KEY, {
      firstName: APPLICANT_NAME,
      lastName: APPLICANT.last_name,
      emailAddress: APPLICANT.email,
    }),
    keeper.putAsync(DOC_KEY, {
      _t: 'tradle.DrivingLicense',
      licenseNumber: '1234567890',
      photos: [{ url: '..some data uri..' }]
    })
  ])
})

// const Onfido = {
//   applicants:
//     createApplicant: function () {

//     }
//   }
// }

// possible flows
//   1 step
//     consider
//     clear
//   2 steps
//     in_progress + webhook + consider
//     in_progress + webhook + clear

test('create applicant', co(function* (t) {
  const applicant = fixtures.applicants[0]
  const applicantId = applicant.id
  const onfido = mockClient({ applicant })
  yield putTestData(onfido.node.keeper)

  const db = onfido.db
  db.once('applicant:queue', function (applicant) {
    const props = tradle.utils.pick(applicant, ['applicant', 'personalInfo', 'status'])
    t.same(props, {
      applicant: APPLICANT_NAME,
      personalInfo: PERSONAL_INFO_KEY,
      status: status.applicant.new
    })
  })

  db.once('applicant:create', co(function* (applicant) {
    const props = tradle.utils.pick(applicant, ['applicant', 'personalInfo', 'status'])
    t.same(props, {
      applicant: APPLICANT_NAME,
      personalInfo: PERSONAL_INFO_KEY,
      status: status.applicant.created
    })

    yield cleanup(onfido)
    t.end()
  }))

  yield onfido.createApplicant({ applicant: APPLICANT_NAME, personalInfo: PERSONAL_INFO_KEY })
}))

;['clear', 'consider'].forEach(result => {
  test('one step ' + result, co(function* (t) {
    const applicant = fixtures.applicants[0]
    const applicantId = applicant.id
    const check = adjustCheck(fixtures.checks[applicantId][0], { status: 'complete', result })
    const document = fixtures.documents[applicantId][0]
    const onfido = mockClient({
      applicant: applicant,
      check: check,
      document: document,
      report: check.reports[0]
    })

    yield putTestData(onfido.node.keeper)

    const db = onfido.db
    const docEvents = Promise.map(['document:create', 'document:complete'], function (event) {
      return new Promise(resolve => {
        db.once(event, function (document) {
          const props = tradle.utils.pick(document, ['applicant', 'link', 'status', 'result'])
          t.same(props, {
            applicant: APPLICANT_NAME,
            link: DOC_KEY,
            status: status.document.complete,
            result
          })

          resolve()
        })
      })
    })

    yield onfido.createApplicant({ applicant: APPLICANT_NAME, personalInfo: PERSONAL_INFO_KEY })
    yield onfido.checkDocument({
      applicant: APPLICANT_NAME,
      link: DOC_KEY
    })

    yield docEvents
    t.notOk(yield onfido.db.getPendingDocument(APPLICANT_NAME))

    const verified = yield collect(onfido.db.streamVerifiedDocuments())
    t.equal(verified.length, result === 'clear' ? 1 : 0)

    const failed = yield collect(onfido.db.streamFailedDocuments())
    t.equal(failed.length, result === 'clear' ? 0 : 1)

    yield cleanup(onfido)
    t.end()
  }))

  test('two step ' + result, co(function* (t) {
    const applicant = fixtures.applicants[0]
    const applicantId = applicant.id
    const check = adjustCheck(fixtures.checks[applicantId][0], { status: 'in_progress' })
    const document = fixtures.documents[applicantId][0]
    const pendingReport = check.reports[0]
    const completeReport = adjustCheck(pendingReport, { status: 'complete', result })
    const onfido = mockClient({
      applicant: applicant,
      check: check,
      document: document,
      report: completeReport
    })

    yield putTestData(onfido.node.keeper)

    const db = onfido.db
    const docQueued = new Promise(resolve => {
      db.once('document:queue', function (document) {
        const props = tradle.utils.pick(document, ['applicant', 'link', 'status'])
        t.same(props, {
          applicant: APPLICANT_NAME,
          link: DOC_KEY,
          status: status.document.new
        })

        resolve()
      })
    })

    const docCreated = new Promise(resolve => {
      db.once('document:create', function (document) {
        const props = tradle.utils.pick(document, ['applicant', 'link', 'status'])
        t.same(props, {
          applicant: APPLICANT_NAME,
          link: DOC_KEY,
          status: status.getDocumentStatus(check)
        })

        resolve()
      })
    })

    // const docChecked = new Promise(resolve => {
    //   db.once('document:checked', function (document) {
    //     const props = tradle.utils.pick(document, ['applicant', 'link', 'resultStatus', 'report'])
    //     t.same(props, {
    //       applicant: APPLICANT_NAME,
    //       link: DOC_KEY,
    //       report: '1',
    //       resultStatus: '1'
    //     })

    //     resolve()
    //   })
    // })

    const docVerified = new Promise(resolve => {
      db.once('document:complete', function (document) {
        const props = tradle.utils.pick(document, ['applicant', 'link', 'status', 'result'])
        t.same(props, {
          applicant: APPLICANT_NAME,
          link: DOC_KEY,
          status: status.document.complete,
          result
        })

        resolve()
      })
    })

    yield onfido.createApplicant({ applicant: APPLICANT_NAME, personalInfo: PERSONAL_INFO_KEY })
    yield onfido.checkDocument({
      applicant: APPLICANT_NAME,
      link: DOC_KEY
    })

    yield Promise.all([docQueued, docCreated])
    t.ok(yield onfido.db.getPendingDocument(APPLICANT_NAME))

    const webhookReq = new PassThrough()
    webhookReq.write(JSON.stringify({
      payload: {
        resource_type: 'report',
        action: 'report.completed',
        object: {
          id: pendingReport.id,
          status: 'completed',
          completed_at: new Date().toJSON(), // for correct format
          href: pendingReport.href
        }
      }
    }))

    webhookReq.end()

    const webhookRes = {
      status: function (code) {
        t.equal(code, 200)
        return webhookRes
      },
      end: function () {
        // t.pass()
      }
    }

    yield onfido.processEvent(webhookReq, webhookRes)
    yield docVerified
    t.notOk(yield onfido.db.getPendingDocument(APPLICANT_NAME))

    const verified = yield collect(onfido.db.streamVerifiedDocuments())
    t.equal(verified.length, result === 'clear' ? 1 : 0)

    const failed = yield collect(onfido.db.streamFailedDocuments())
    t.equal(failed.length, result === 'clear' ? 0 : 1)

    yield cleanup(onfido)
    t.end()
  }))
})

// test.skip('integration', co(function* (t) {
//   const rawKeeper = tradle.utils.levelup('./test.db')
//   const keeper = Promise.promisifyAll(rawKeeper)
//   const changes = changesFeed(tradle.utils.levelup('./log.db'))
//   const api = new Onfido({ token: process.env.ONFIDO_API_KEY })
//   const onfido = createOnfido({
//     node: mockNode({ keeper: rawKeeper, changes }),
//     db: 'test',
//     api: api
//   })

//   const applicantId = '0cc317bc-00a5-4e4b-8085-4485fceab85a'
//   const photo = parseDataUri(fixtures.docImages.driving_license)
//   // const doc = yield api.applicants.uploadDocument(applicantId, {
//   //   file: photo.data,
//   //   filename: 'license.' + photo.mimeType.split('/')[1],
//   //   type: 'driving_licence'
//   // })

//   const doc = require('./fixtures/documents')[0]
//   // const check = yield api.checks.createDocumentCheck(applicantId)

//   const check = require('./fixtures/checks')[0]
//   // console.log(check)
//   // const applicants = require('./fixtures/applicants.json')
//   // const checks = {}
//   // yield Promise.all(applicants.map(co(function* ({ id }) {
//   //   checks[id] = yield api.checks.list({ applicantId: id, expandReports: true })
//   // })))

//   // yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/checks.json'), JSON.stringify(checks, null, 2))

//   // yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/applicants.json'), JSON.stringify(applicants, null, 2))
//   t.end()
// }))

const createApplicantFixtures = co(function* createApplicantFixtures () {
  const api = new Onfido({ token: process.env.ONFIDO_API_KEY })
  const applicants = yield api.applicants.list()
  yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/applicants.json'), JSON.stringify(applicants, null, 2))
})

const createDocumentFixtures = co(function* createDocumentFixtures () {
  const api = new Onfido({ token: process.env.ONFIDO_API_KEY })
  const applicants = require('./fixtures/applicants')
  const documents = {}
  yield Promise.all(applicants.map(co(function* ({ id }) {
    documents[id] = yield api.applicants.listDocuments(applicantId)
  })))

  yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/documents.json'), JSON.stringify(documents, null, 2))
})

const createCheckFixtures = co(function* createCheckFixtures () {
  const api = new Onfido({ token: process.env.ONFIDO_API_KEY })
  const applicants = require('./fixtures/applicants')
  const checks = {}
  yield Promise.all(applicants.map(co(function* ({ id }) {
    checks[id] = yield api.checks.list({ applicantId: id, expandReports: true })
  })))

  yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/checks.json'), JSON.stringify(checks, null, 2))
})

const createWebhookFixtures = co(function* createWebhookFixtures () {
  const webhooks = api.webhooks.list()
  yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/webhooks.json'), JSON.stringify(webhooks, null, 2))
})

const createFixtures = co(function* createFixtures () {
  yield createApplicantFixtures()
  yield createDocumentFixtures()
  yield createCheckFixtures()
  yield createWebhookFixtures()
})

function mockClient (opts) {
  const node = mockNode()
  const client = createOnfido({
    node: node,
    db: 'test',
    api: mockAPI(opts)
  })

  client.node = node
  return client
}

let dbCounter = 0
function mockNode () {
  // const keeper = testHelpers.keeper()

  const logdb = Promise.promisifyAll(testHelpers.nextDB())
  const changes = Promise.promisifyAll(changesFeed(logdb))
  const ee = new EventEmitter()
  ee.keeper = Promise.promisifyAll(testHelpers.keeper())
  ee.changes = changes
  ee.destroy = () => {
    return logdb.closeAsync()
  }

  ee._createDB = function (path) {
    return tradle.utils.levelup(path, { db: memdown })
  }

  return ee
}

function mockAPI ({ applicant, document, check, report }) {
  return {
    applicants: {
      createApplicant: function () {
        return Promise.resolve(applicant)
      },
      uploadDocument: function () {
        return Promise.resolve(document)
      }
    },
    checks: {
      createDocumentCheck: function () {
        return Promise.resolve(check)
      }
    },
    reports: {
      get: function (id) {
        if (report) {
          return Promise.resolve(report)
        }

        const match = check.reports.find(r => r.id === id)
        if (match) Promise.resolve(match)
        else Promise.reject(new Error('report not found'))
      }
    },
    webhooks: {
      handleEvent: co(function* (req) {
        const body = yield collect(req)
        return JSON.parse(body).payload
      })
    }
  }
}

function adjustCheck (obj, props) {
  const copy = tradle.utils.clone(obj, props)
  if (copy.reports) {
    copy.reports = copy.reports.map(r => {
      return tradle.utils.clone(r, props)
    })
  }

  return copy
}

const cleanup = co(function* cleanup (client) {
  yield Promise.all([
    client.close(),
    client.node.destroy()
  ])

  memdown.clearGlobalStore()
})
