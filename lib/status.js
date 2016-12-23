
const webhook = {
  'registerqueued': '0',
  'unregisterqueued': '1',
  'registered': '2',
  'unregister': '3'
}

// exports.create = {
//   'todo': '0',
//   'done': '1'
// }

// exports.pending = {
//   pending: '0',
//   done: '1'
// }

const applicant = {
  new: '0',
  created: '1'
}

const document = {
  new: '0',
  created: '1',
  awaiting_data: '2',
  awaiting_applicant: '3',
  checked: '4',
  complete: '5'
}

function getDocumentStatus (checkOrReport) {
  const { status, result } = checkOrReport
  switch (status) {
  case 'in_progress': return document.created
  case 'completed':
  case 'complete': {
    if (result) {
      return document.complete
    } else {
      return document.checked
    }
  }
  case 'awaiting_data': return document.awaiting_data
  case 'awaiting_applicant': return document.awaiting_applicant
  default: throw new Error('unknown status: ' + status)
  }
}

module.exports = {
  webhook,
  applicant,
  document,
  getDocumentStatus
}
