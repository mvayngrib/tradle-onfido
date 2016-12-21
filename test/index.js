
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
const fixtures = require('./fixtures')
const docImages = require('./fixtures/document-images')

// const Onfido = {
//   applicants:
//     createApplicant: function () {

//     }
//   }
// }

test('basic', co(function* (t) {
  const rawKeeper = testHelpers.keeper()
  const keeper = Promise.promisifyAll(rawKeeper)
  const changes = testHelpers.nextFeed()
  const api = {
    applicants: {
      createApplicant: function (applicantData) {
        return Promise.resolve(fixtures.applicants[0])
      },
      uploadDocument: function (applicantId, doc) {
        return Promise.resolve(fixtures.documents[0])
      }
    },
    checks: {
      createDocumentCheck: function (id) {
        return Promise.resolve(fixtures.checks[0])
      }
    },
    reports: {
      get: function (id) {
        const report = fixtures.reports.find(report => report.id === id)
        const clear = tradle.utils.clone(report, { result: 'clear' })
        return Promise.resolve(clear)
      }
    },
    webhooks: {
      handleEvent: co(function* (req) {
        const body = yield collect(req)
        return JSON.parse(body).payload
      })
    }
  }

  const onfido = createOnfido({
    node: mockNode({ keeper: rawKeeper, changes }),
    db: 'test',
    api: api
  })

  const db = onfido.db
  db.once('applicant:queue', function (applicant) {
    const props = tradle.utils.pick(applicant, ['applicant', 'personalInfo', 'status'])
    t.same(props, {
      applicant: 'bob',
      personalInfo: 'bobinfo',
      status: status.applicant.new
    })
  })

  db.once('applicant:create', function (applicant) {
    const props = tradle.utils.pick(applicant, ['applicant', 'personalInfo', 'status'])
    t.same(props, {
      applicant: 'bob',
      personalInfo: 'bobinfo',
      status: status.applicant.created
    })
  })

  db.once('document:queue', function (document) {
    const props = tradle.utils.pick(document, ['applicant', 'link', 'status'])
    t.same(props, {
      applicant: 'bob',
      link: 'bobdoc',
      status: status.document.new
    })
  })

  const docCreated = new Promise(resolve => {
    db.once('document:create', function (document) {
      const props = tradle.utils.pick(document, ['applicant', 'link', 'status'])
      t.same(props, {
        applicant: 'bob',
        link: 'bobdoc',
        status: status.applicant.created
      })

      resolve()
    })
  })

  // const docChecked = new Promise(resolve => {
  //   db.once('document:checked', function (document) {
  //     const props = tradle.utils.pick(document, ['applicant', 'link', 'resultStatus', 'report'])
  //     t.same(props, {
  //       applicant: 'bob',
  //       link: 'bobdoc',
  //       report: '1',
  //       resultStatus: '1'
  //     })

  //     resolve()
  //   })
  // })

  const docVerified = new Promise(resolve => {
    db.once('document:verified', function (document) {
      const props = tradle.utils.pick(document, ['applicant', 'link', 'status', 'result'])
      t.same(props, {
        applicant: 'bob',
        link: 'bobdoc',
        status: status.document.complete,
        result: 'clear'
      })

      resolve()
    })
  })

  yield Promise.all([
    keeper.put('bob', { name: 'bob' }),
    keeper.put('bobinfo', {
      firstName: 'bob',
      lastName: 'bobble',
      emailAddress: 'bob@bobble.com',
    }),
    keeper.put('bobdoc', {
      _t: 'tradle.Passport',
      passportNumber: '1234567890',
      photos: [{ url: '..some data uri..' }]
    })
  ])

  yield onfido.createApplicant({ applicant: 'bob', personalInfo: 'bobinfo' })
  yield onfido.checkDocument({
    applicant: 'bob',
    link: 'bobdoc'
  })

  yield docCreated
  const report = fixtures.reports[0]
  const webhookReq = new PassThrough()
  webhookReq.write(JSON.stringify({
    payload: {
      resource_type: 'report',
      action: 'report.completed',
      object: {
        id: report.id,
        status: 'completed',
        completed_at: '2014-05-23T13:50:33Z',
        href: 'https://api.onfido.com/v2/checks/12343-11122-09290/reports/12345-23122-32123'
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
      t.pass()
    }
  }

  yield onfido.processEvent(webhookReq, webhookRes)
  yield docVerified
  const pending = yield onfido.db.getPendingDocument()
  t.equal(pending, undefined)
  t.end()
}))

test.only('integration', co(function* (t) {
  const rawKeeper = tradle.utils.levelup('./test.db')
  const keeper = Promise.promisifyAll(rawKeeper)
  const changes = changesFeed(tradle.utils.levelup('./log.db'))
  const api = new Onfido({ token: process.env.ONFIDO_API_KEY })
  const onfido = createOnfido({
    node: mockNode({ keeper: rawKeeper, changes }),
    db: 'test',
    api: api
  })

  const applicantId = '0cc317bc-00a5-4e4b-8085-4485fceab85a'
  const photo = parseDataUri(docImages.driving_license)
  // const doc = yield api.applicants.uploadDocument(applicantId, {
  //   file: photo.data,
  //   filename: 'license.' + photo.mimeType.split('/')[1],
  //   type: 'driving_licence'
  // })

  const [doc] = require('./fixtures/documents')
  const check = yield api.checks.createDocumentCheck(applicantId)

  console.log(check)
  // const applicants = require('./fixtures/applicants.json')
  // const checks = {}
  // yield Promise.all(applicants.map(co(function* ({ id }) {
  //   checks[id] = yield api.checks.list({ applicantId: id, expandReports: true })
  // })))

  // yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/checks.json'), JSON.stringify(checks, null, 2))

  // yield fs.writeFileAsync(path.resolve(__dirname, './fixtures/applicants.json'), JSON.stringify(applicants, null, 2))
  t.end()
}))

// 0cc317bc-00a5-4e4b-8085-4485fceab85a

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

function mockNode ({ keeper, changes }) {
  const ee = new EventEmitter()
  ee.keeper = keeper
  ee.changes = changes
  ee._createDB = function (path) {
    return tradle.utils.levelup(path, { db: memdown })
  }

  return ee
}
