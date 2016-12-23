module.exports = prefixValues({
  queueapplicant: 'onfido:applicant:queue',
  updateapplicant: 'onfido:applicant:update',
  applicant: 'onfido:applicant',
  queuecheck: 'onfido:check:queue',
  check: 'onfido:check',
  queuedocument: 'onfido:document:queue',
  document: 'onfido:document',
  documentstatus: 'onfido:document:status',
  registerwebhook: 'onfido:webhook:register',
  registeredwebhook: 'onfido:webhook:registered',
  unregisterwebhook: 'onfido:webhook:unregister',
  unregisteredwebhook: 'onfido:webhook:unregistered'
  // report: 'onfido:report',
}, process.env.ONFIDO_TOPIC_PREFIX || '')

function prefixValues (obj, prefix='') {
  const prefixed = {}
  for (var p in obj) {
    prefixed[p] = prefix + obj[p]
  }

  return prefixed
}
