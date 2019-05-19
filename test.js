var tape = require('tape')
var cabalDns = require('./index')()

var FAKE_CABAL = 'f'.repeat(64)

tape('Successful test against cblgh.org', function (t) {
  cabalDns.resolveName('cblgh.org', function (err, name) {
    t.error(err)
    t.ok(/[0-9a-f]{64}/.test(name))

    cabalDns.resolveName('cblgh.org').then(function (name2) {
      t.equal(name, name2)
      t.end()
    })
  })
})

tape('Works for keys', function (t) {
  cabalDns.resolveName('14bc77d788fdaf07b89b28e9d276e47f2e44011f4adb981921056e1b3b40e99e', function (err, name) {
    t.error(err)
    t.equal(name, '14bc77d788fdaf07b89b28e9d276e47f2e44011f4adb981921056e1b3b40e99e')
    t.end()
  })
})

