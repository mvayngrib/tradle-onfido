
const PassThrough = require('stream').PassThrough
const { EventEmitter } = require('events')
const test = require('tape')
const Promise = require('bluebird')
const co = Promise.coroutine
const collect = Promise.promisify(require('stream-collector'))
const tradle = require('@tradle/engine')
const testHelpers = require('@tradle/engine/test/helpers')
const changesFeed = require('changes-feed')
const memdown = require('memdown')
const createOnfidoDB = require('../db')
const status = require('../status')
const createOnfido = require('../')
const fixtures = require('./fixtures')

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

function mockNode ({ keeper, changes }) {
  const ee = new EventEmitter()
  ee.keeper = keeper
  ee.changes = changes
  ee._createDB = function (path) {
    return tradle.utils.levelup(path, { db: memdown })
  }

  return ee
}
