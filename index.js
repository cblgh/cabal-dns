const debug = require('debug')('cabal')
const url = require('url')
const https = require('https')
const Emitter = require('events')
const {stringify} = require('querystring')
const memoryCache = require('./cache')
const callMeMaybe = require('call-me-maybe')
const concat = require('concat-stream')

const CABAL_HASH_REGEX = /^[0-9a-f]{64}?$/i
const VERSION_REGEX = /(\+[^\/]+)$/
const DEFAULT_CABAL_DNS_TTL = 3600 // 1hr
const MAX_CABAL_DNS_TTL = 3600 * 24 * 7 // 1 week
const DEFAULT_DNS_PROVIDERS = [['cloudflare-dns.com','/dns-query'],['dns.google.com','/resolve'],['dns.quad9.net','/dns-query']]

// helper to support node6
function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

// helper to call promise-generating function
function maybe (cb, p) {
  if (typeof p === 'function') {
    p = p()
  }
  return callMeMaybe(cb, p)
}

module.exports = function (cabalDnsOpts) {
  cabalDnsOpts = cabalDnsOpts || {}
  var pCache = cabalDnsOpts.persistentCache
  var mCache = memoryCache()
  if (!cabalDnsOpts.dnsHost || !cabalDnsOpts.dnsPath) {
    let dnsProvider = DEFAULT_DNS_PROVIDERS[Math.floor(Math.random()*DEFAULT_DNS_PROVIDERS.length)];
    var dnsHost = dnsProvider[0]
    var dnsPath = dnsProvider[1]
  } else {
    var dnsHost = cabalDnsOpts.dnsHost
    var dnsPath = cabalDnsOpts.dnsPath
  }

  var cabalDns = new Emitter()

  function resolveName (name, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    var ignoreCache = opts && opts.ignoreCache
    var ignoreCachedMiss = opts && opts.ignoreCachedMiss
    var noDnsOverHttps = opts && opts.noDnsOverHttps
    var noWellknownCabal = opts && opts.noWellknownCabal
    return maybe(cb, _asyncToGenerator(function* () {
      // parse the name as needed
      var nameParsed = url.parse(name)
      name = nameParsed.hostname || nameParsed.pathname

      // strip the version
      name = name.replace(VERSION_REGEX, '')

      // is it a hash?
      if (CABAL_HASH_REGEX.test(name)) {
        return name.slice(0, 64)
      }

      try {
        // check the cache
        if (!ignoreCache) {
          const cachedKey = mCache.get(name)
          if (typeof cachedKey !== 'undefined') {
            if (cachedKey || (!cachedKey && !ignoreCachedMiss)) {
              debug('In-memory cache hit for name', name, cachedKey)
              if (cachedKey) return cachedKey
              else throw new Error('DNS record not found') // cached miss
            }
          }
        }

        var res
        var key
        var ttl

        if (!noDnsOverHttps) {
          try {
            // do a DNS-over-HTTPS lookup
            res = yield fetchDnsOverHttpsRecord(name, {host: dnsHost, path: dnsPath})

            // parse the record
            res = parseDnsOverHttpsRecord(cabalDns, name, res.body)
            cabalDns.emit('resolved', {
              method: 'dns-over-https',
              name,
              key: res.key
            })
            debug('dns-over-http resolved', name, 'to', res.key)
          } catch (e) {
            // ignore, we'll try .well-known/cabal next
            res = false
          }
        }

        if (!res && !noWellknownCabal) {
          // do a .well-known/cabal lookup
          res = yield fetchWellKnownRecord(name)
          if (res.statusCode === 0 || res.statusCode === 404) {
            debug('.well-known/cabal lookup failed for name:', name, res.statusCode, res.err)
            cabalDns.emit('failed', {
              method: 'well-known',
              name,
              err: 'HTTP code ' + res.statusCode + ' ' + res.err
            })
            mCache.set(name, false, 60) // cache the miss for a minute
            throw new Error('DNS record not found')
          } else if (res.statusCode !== 200) {
            debug('.well-known/cabal lookup failed for name:', name, res.statusCode)
            cabalDns.emit('failed', {
              method: 'well-known',
              name,
              err: 'HTTP code ' + res.statusCode
            })
            throw new Error('DNS record not found')
          }

          // parse the record
          res = parseWellknownCabalRecord(cabalDns, name, res.body)
          cabalDns.emit('resolved', {
            method: 'well-known',
            name,
            key: res.key
          })
          debug('.well-known/cabal resolved', name, 'to', res.key)
        }

        // cache
        if (res.ttl !== 0) mCache.set(name, res.key, res.ttl)
        if (pCache) pCache.write(name, res.key, res.ttl)

        return res.key
      } catch (err) {
        if (pCache) {
          // read from persistent cache on failure
          return pCache.read(name, err)
        }
        throw err
      }
    }))
  }

  function listCache () {
    return mCache.list()
  }

  function flushCache () {
    cabalDns.emit('cache-flushed')
    mCache.flush()
  }

  cabalDns.resolveName = resolveName
  cabalDns.listCache = listCache
  cabalDns.flushCache = flushCache
  return cabalDns
}

function fetchDnsOverHttpsRecord (name, {host, path}) {
  return new Promise((resolve, reject) => {
    // ensure the name is a FQDN
    if (!name.includes('.')) {
      debug('dns-over-https failed', name, 'Not an a FQDN')
      cabalDns.emit('failed', {
        method: 'dns-over-https',
        name,
        err: 'Name is not a FQDN'
      })
      reject('Domain is not a FQDN.')
    }
    else if (!name.endsWith('.')) {
      name = name+'.'
    }
    var query = {
      name,
      type: 'TXT'
    }
    debug('dns-over-https lookup for name:', name)
    https.get({
      host,
      path: `${path}?${stringify(query)}`,
      // Cloudflare requires this exact header; luckily everyone else ignores it
      headers: {
        'Accept': 'application/dns-json'
      },
      timeout: 2000
    }, function (res) {
      res.setEncoding('utf-8')
      res.pipe(concat(body => resolve({statusCode: res.statusCode, body})))
    }).on('error', function (err) {
      resolve({statusCode: 0, err, body: ''})
    })
  })
}

function parseDnsOverHttpsRecord (cabalDns, name, body) {
  // decode to obj
  var record
  try {
    record = JSON.parse(body)
  } catch (e) {
    debug('dns-over-https failed', name, 'did not give a valid JSON response')
    cabalDns.emit('failed', {
      method: 'dns-over-https',
      name,
      err: 'Failed to parse JSON response'
    })
    throw new Error('Invalid dns-over-https record, must provide json')
  }

  // find valid answers
  var answers = record['Answer']
  if (!answers || !Array.isArray(answers)) {
    debug('dns-over-https failed', name, 'did not give any TXT answers')
    cabalDns.emit('failed', {
      method: 'dns-over-https',
      name,
      err: 'Did not give any TXT answers'
    })
    throw new Error('Invalid dns-over-https record, no TXT answers given')
  }
  answers = answers.filter(a => {
    if (!a || typeof a !== 'object') {
      return false
    }
    if (typeof a.data !== 'string') {
      return false
    }
    var match = /^"?datkey=([0-9a-f]{64})"?$/i.exec(a.data)
    if (!match) {
      return false
    }
    a.key = match[1]
    return true
  })
  if (!answers[0]) {
    debug('dns-over-https failed', name, 'did not give any TXT datkey answers')
    cabalDns.emit('failed', {
      method: 'dns-over-https',
      name,
      err: 'Did not give any TXT datkey answers'
    })
    throw new Error('Invalid dns-over-https record, no TXT datkey answer given')
  }

  // put together res
  var res = {key: answers[0].key, ttl: answers[0].TTL}
  if (!Number.isSafeInteger(res.ttl) || res.ttl < 0) {
    res.ttl = DEFAULT_CABAL_DNS_TTL
  }
  if (res.ttl > MAX_CABAL_DNS_TTL) {
    res.ttl = MAX_CABAL_DNS_TTL
  }
  return res
}

function fetchWellKnownRecord (name) {
  return new Promise((resolve, reject) => {
    debug('.well-known/cabal lookup for name:', name)
    https.get({
      host: name,
      path: '/.well-known/cabal',
      timeout: 2000
    }, function (res) {
      res.setEncoding('utf-8')
      res.pipe(concat(body => resolve({statusCode: res.statusCode, body})))
    }).on('error', function (err) {
      resolve({statusCode: 0, err, body: ''})
    })
  })
}

function parseWellknownCabalRecord (cabalDns, name, body) {
  if (!body || typeof body != 'string') {
    cabalDns.emit('failed', {
      method: 'well-known',
      name,
      err: 'Empty response'
    })
    throw new Error('DNS record not found')
  }

  const lines = body.split('\n')
  var key, ttl

  // parse url
  try {
    key = /^cabal:\/\/([0-9a-f]{64})/i.exec(lines[0])[1]
  } catch (e) {
    debug('.well-known/cabal failed', name, 'Must be a cabal://{key} url')
    cabalDns.emit('failed', {
      method: 'well-known',
      name,
      err: 'Record did not provide a valid cabal://{key} url'
    })
    throw new Error('Invalid .well-known/cabal record, must provide a cabal://{key} url')
  }

  // parse ttl
  try {
    if (lines[1]) {
      ttl = +(/^ttl=(\d+)$/i.exec(lines[1])[1])
    }
  } catch (e) {
    cabalDns.emit('failed', {
      method: 'well-known',
      name,
      err: 'Failed to parse TTL line, error: ' + e.toString()
    })
    debug('.well-known/cabal failed to parse TTL for %s, line: %s, error:', name, lines[1], e)
  }
  if (!Number.isSafeInteger(ttl) || ttl < 0) {
    ttl = DEFAULT_CABAL_DNS_TTL
  }
  if (ttl > MAX_CABAL_DNS_TTL) {
    ttl = MAX_CABAL_DNS_TTL
  }

  return {key, ttl}
}
