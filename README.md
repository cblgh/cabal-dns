# cabal-dns

Cabal-specific fork of [datprotocol/dat-dns](https://github.com/datprotocol/dat-dns), originally written by [pfrazee](https://github.com/pfrazee)

Issue DNS lookups for Dat archives using HTTPS requests to the target host. Keeps an in-memory cache of recent lookups.

## API

```js
var cabalDns = require('cabal-dns')()

// resolve a name: pass the hostname by itself
cabalDns.resolveName('foo.com', function (err, key) { ... })
cabalDns.resolveName('foo.com').then(key => ...)

// dont use cached 'misses'
cabalDns.resolveName('foo.com', {ignoreCachedMiss: true})

// dont use the cache at all
cabalDns.resolveName('foo.com', {ignoreCache: true})

// dont use dns-over-https
cabalDns.resolveName('foo.com', {noDnsOverHttps: true})

// dont use .well-known/dat
cabalDns.resolveName('foo.com', {noWellknownDat: true})

// list all entries in the cache
cabalDns.listCache()

// clear the cache
cabalDns.flushCache()

// configure the DNS-over-HTTPS host used
var cabalDns = require('cabal-dns')({
  dnsHost: 'dns.google.com',
  dnsPath: '/resolve'
})

// use a persistent fallback cache
// (this is handy for persistent dns data when offline)
var cabalDns = require('cabal-dns')({
  persistentCache: {
    read: async (name, err) => {
      // try lookup
      // if failed, you can throw the original error:
      throw err
    },
    write: async (name, key, ttl) => {
      // write to your cache
    }
  }
})

// emits some events, mainly useful for logging/debugging
cabalDns.on('resolved', ({method, name, key}) => {...})
cabalDns.on('failed', ({method, name, err}) => {...})
cabalDns.on('cache-flushed', () => {...})
```

## Spec

[In detail.](https://www.datprotocol.com/deps/0005-dns/)

**Option 1 (DNS-over-HTTPS).** Create a DNS TXT record witht he following schema:

```
datkey={key}
```

**Option 2 (.well-known/dat).** Place a file at `/.well-known/dat` with the following schema:

```
{cabal-url}
TTL={time in seconds}
```

TTL is optional and will default to `3600` (one hour). If set to `0`, the entry is not cached.
