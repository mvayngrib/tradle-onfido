
const path = require('path')
const PassThrough = require('stream').PassThrough
const { EventEmitter } = require('events')
const test = require('tape')
const Promise = require('bluebird')
const co = Promise.coroutine
const fs = Promise.promisifyAll(require('fs'))
const collect = Promise.promisify(require('stream-collector'))
const { utils, constants } = require('@tradle/engine')
const { TYPE } = constants
const testHelpers = require('@tradle/engine/test/helpers')
const changesFeed = require('changes-feed')
const memdown = require('memdown')
const parseDataUri = require('parse-data-uri')
const omit = require('object.omit')
const Onfido = require('@tradle/onfido-api')
const createOnfidoDB = require('../lib/db')
const status = require('../lib/status')
const convert = require('../lib/convert')
const createOnfido = require('../')
const mock = require('./mock')
const fixtures = {
  applicants: require('./fixtures/applicants'),
  checks: require('./fixtures/checks'),
  documents: require('./fixtures/documents'),
  documentImages: require('./fixtures/document-images'),
  tradle: require('./fixtures/tradle')
}

// const keeper = Promise.promisifyAll(testHelpers.keeper())

const APPLICANT = fixtures.applicants[0]
const APPLICANT_NAME = APPLICANT.first_name
const PERSONAL_INFO_KEY = APPLICANT_NAME + '-personalInfo'
const DOC_KEY = APPLICANT_NAME + '-doc'
const FACE_KEY = APPLICANT_NAME + '-face'
const putTestData = co(function* (keeper) {
  yield Promise.all([
    keeper.putAsync(APPLICANT_NAME, { name: APPLICANT_NAME }),
    keeper.putAsync(PERSONAL_INFO_KEY, fixtures.tradle['tradle.PersonalInfo']),
    keeper.putAsync(DOC_KEY, fixtures.tradle['tradle.DrivingLicense']),
    keeper.putAsync(FACE_KEY, fixtures.tradle['tradle.LiveFace'])
  ])
})

test('convert', function (t) {
  const pi = fixtures.tradle['tradle.PersonalInfo']
  const applicant = convert.toOnfido(pi)
  t.same(applicant, {
    first_name: pi.firstName,
    last_name: pi.lastName,
    email: pi.emailAddress,
    gender: pi.sex.title
  })

  const license = fixtures.tradle['tradle.DrivingLicense']
  const olicense = convert.toOnfido(license)
  t.same(omit(olicense, 'filename'), {
    file: parseDataUri(license.photos[0].url).data,
    // filename: 'license.jpg',
    type: 'driving_license'
  })

  t.throws(() => convert.toTradle({ document_type: 'booglie' }))
  t.throws(() => convert.toOnfido({ [TYPE]: 'tradle.SomeType' }))
  t.end()
})

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
  const onfido = mock.client({ applicants: [applicant] })
  yield putTestData(onfido.keeper)

  const db = onfido.db
  db.once('applicant:queue', function (applicant) {
    const props = utils.pick(applicant, ['applicant', 'personalInfo', 'status'])
    t.same(props, {
      applicant: APPLICANT_NAME,
      personalInfo: PERSONAL_INFO_KEY,
      status: status.applicant.new
    })
  })

  db.once('applicant:create', co(function* (applicant) {
    const props = utils.pick(applicant, ['applicant', 'personalInfo', 'status'])
    t.same(props, {
      applicant: APPLICANT_NAME,
      personalInfo: PERSONAL_INFO_KEY,
      status: status.applicant.uptodate
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
    const onfido = mock.client({
      applicants: [applicant],
      checks: [check],
      documents: [document],
      reports: check.reports.slice(0, 1)
    })

    yield putTestData(onfido.keeper)

    const db = onfido.db
    const docEvents = Promise.map(['document:create', 'document:complete'], function (event) {
      return new Promise(resolve => {
        db.once(event, function (document) {
          const props = utils.pick(document, ['applicant', 'link', 'status', 'result'])
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
    const completeCheck = adjustCheck(check, { status: 'complete', result })
    const onfido = mock.client({
      applicants: [applicant],
      checks: [check, completeCheck],
      documents: [document]
    })

    yield putTestData(onfido.keeper)

    const db = onfido.db
    const docQueued = new Promise(resolve => {
      db.once('document:queue', function (document) {
        const props = utils.pick(document, ['applicant', 'link', 'status'])
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
        const props = utils.pick(document, ['applicant', 'link', 'status'])
        t.same(props, {
          applicant: APPLICANT_NAME,
          link: DOC_KEY,
          status: status.getDocumentStatus(check)
        })

        resolve()
      })
    })

    const docVerified = new Promise(resolve => {
      db.once('document:complete', function (document) {
        const props = utils.pick(document, ['applicant', 'link', 'status', 'result'])
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
        resource_type: 'check',
        action: 'check.completed',
        object: {
          id: check.id,
          status: 'completed',
          completed_at: new Date().toJSON(), // for correct format
          href: check.href
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

  test('three step ' + result, co(function* (t) {
    const applicant = fixtures.applicants[0]
    const applicantId = applicant.id
    const check = adjustCheck(fixtures.checks[applicantId][1], { status: 'in_progress' })
    const document = fixtures.documents[applicantId][0]
    const pendingReport = check.reports[0]
    const completeCheck = adjustCheck(check, { status: 'complete', result })
    const onfido = mock.client({
      applicants: [applicant],
      checks: [check, completeCheck],
      documents: [document]
    })

    yield putTestData(onfido.keeper)

    const db = onfido.db
    const docQueued = new Promise(resolve => {
      db.once('document:queue', function (document) {
        const props = utils.pick(document, ['applicant', 'link', 'status'])
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
        const props = utils.pick(document, ['applicant', 'link', 'status'])
        t.same(props, {
          applicant: APPLICANT_NAME,
          link: DOC_KEY,
          status: status.getDocumentStatus(check)
        })

        resolve()
      })
    })

    const docVerified = new Promise(resolve => {
      db.once('document:complete', function (document) {
        const props = utils.pick(document, ['applicant', 'link', 'status', 'result'])
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

    const uploadedFace = new Promise(resolve => {
      onfido.db.once('face:upload', resolve)
    })

    yield onfido.checkFace({
      applicant: APPLICANT_NAME,
      face: FACE_KEY
    })

    yield uploadedFace

    const webhookReq = new PassThrough()
    webhookReq.write(JSON.stringify({
      payload: {
        resource_type: 'check',
        action: 'check.completed',
        object: {
          id: check.id,
          status: 'completed',
          completed_at: new Date().toJSON(), // for correct format
          href: check.href,
          reports: completeCheck.reports
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

test('register webhook', co(function* (t) {
  const onfido = mock.client({})
  const api = onfido.api
  const url = 'someurl'
  const events = ['report.completed']
  const eventPromises = ['register', 'unregister'].map(type => {
    return new Promise(resolve => {
      onfido.db.on('webhook:' + type, function (webhook) {
        t.equal(webhook.url, url)
        resolve()
      })
    })
  })

  let registered, unregistered
  const reg = new Promise(resolve => registered = resolve)
  const unreg = new Promise(resolve => unregistered = resolve)
  api.registerWebhook = function (data) {
    registered(data)
    return Promise.resolve(data)
  }

  api.unregisterWebhook = function (data) {
    unregistered(data)
    return Promise.resolve(data)
  }

  yield onfido.registerWebhook({ url, events })
  t.same(yield reg, { url, events })
  // should not cause multiple events

  yield eventPromises[0]
  let webhooks = yield onfido.db.getWebhooks()
  t.equal(webhooks.filter(w => w.status === status.webhook.registered).length, 1)

  yield onfido.unregisterWebhook(url)
  t.same(yield unreg, url)
  yield eventPromises[1]

  webhooks = yield onfido.db.getWebhooks()
  t.equal(webhooks.filter(w => w.status === status.webhook.registered).length, 0)

  t.end()
}))

// test.skip('integration', co(function* (t) {
//   const rawKeeper = utils.levelup('./test.db')
//   const keeper = Promise.promisifyAll(rawKeeper)
//   const changes = changesFeed(utils.levelup('./log.db'))
//   const api = new Onfido({ token: process.env.ONFIDO_API_KEY })
//   const onfido = createOnfido({
//     node: mock.Node({ keeper: rawKeeper, changes }),
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

function adjustCheck (obj, props) {
  const copy = utils.clone(obj, props)
  if (copy.reports) {
    copy.reports = copy.reports.map(r => {
      return utils.clone(r, props)
    })
  }

  return copy
}

const cleanup = co(function* cleanup (client) {
  yield Promise.all([
    client.close()
  ])

  memdown.clearGlobalStore()
})
