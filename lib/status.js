
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
  uptodate: '1',
  updating: '2'
}

const document = {
  new: '0',
  uploaded: '1'
}

const face = {
  new: '0',
  uploaded: '1'
}

const check = {
  new: '0',
  created: '1',
  awaiting_data: '2',
  awaiting_applicant: '3',
  checked: '4',
  complete: '5'
}

function getCheckStatus (checkOrReport) {
  const { status, result } = checkOrReport
  switch (status) {
  case 'in_progress': return check.created
  case 'completed':
  case 'complete': {
    if (result) {
      return check.complete
    } else {
      return check.checked
    }
  }
  case 'awaiting_data': return check.awaiting_data
  case 'awaiting_applicant': return check.awaiting_applicant
  default: throw new Error('unknown status: ' + status)
  }
}

module.exports = {
  webhook,
  applicant,
  face,
  document,
  check,
  getCheckStatus,
  // same
  getReportStatus: getCheckStatus
}
