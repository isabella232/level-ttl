const after = require('after')
const xtend = require('xtend')
const encoding = require('./encoding')
const Lock = require('lock').Lock

function prefixKey (db, key) {
  return db._ttl.encoding.encode(db._ttl._prefixNs.concat(key))
}

function expiryKey (db, exp, key) {
  return db._ttl.encoding.encode(db._ttl._expiryNs.concat(exp, key))
}

function buildQuery (db) {
  const encode = db._ttl.encoding.encode
  const expiryNs = db._ttl._expiryNs

  // TODO: add limit (esp. important when checkInterval is long)
  return {
    keyEncoding: 'binary',
    valueEncoding: 'binary',
    gte: encode(expiryNs),
    lte: encode(expiryNs.concat(new Date()))
  }
}

function startTtl (db, checkFrequency) {
  db._ttl.intervalId = setInterval(function () {
    if (db._ttl._checkInProgress) return

    const batch = []
    const subBatch = []
    const sub = db._ttl.sub
    const query = buildQuery(db)
    const decode = db._ttl.encoding.decode
    const it = (sub || db).iterator(query)

    db._ttl._checkInProgress = true
    next()

    function next () {
      it.next(function (err, key, value) {
        if (err) {
          it.end(function () {
            doneReading(err)
          })
        } else if (key === undefined) {
          it.end(doneReading)
        } else {
          // the value is the key!
          const realKey = decode(value)

          // expiryKey that matches this query
          subBatch.push({ type: 'del', key: key })
          subBatch.push({ type: 'del', key: prefixKey(db, realKey) })

          // the actual data that should expire now!
          batch.push({ type: 'del', key: realKey })

          next()
        }
      })
    }

    function doneReading (err) {
      if (err || !batch.length) {
        doneWriting(err)
      } else if (sub) {
        const next = after(2, doneWriting)
        sub.batch(subBatch, { keyEncoding: 'binary' }, next)
        db._ttl.batch(batch, { keyEncoding: 'binary' }, next)
      } else {
        db._ttl.batch(subBatch.concat(batch), { keyEncoding: 'binary' }, doneWriting)
      }
    }

    function doneWriting (err) {
      if (err) db.emit('error', err)

      db._ttl._checkInProgress = false

      // Exposed for unit tests
      // TODO: also use this for _stopAfterCheck
      db.emit('ttl:sweep')

      if (db._ttl._stopAfterCheck) {
        stopTtl(db, db._ttl._stopAfterCheck)
        db._ttl._stopAfterCheck = null
      }
    }
  }, checkFrequency)

  if (db._ttl.intervalId.unref) {
    db._ttl.intervalId.unref()
  }
}

function stopTtl (db, callback) {
  // can't close a db while an interator is in progress
  // so if one is, defer
  if (db._ttl._checkInProgress) {
    db._ttl._stopAfterCheck = callback
    // TODO do we really need to return the callback here?
    return db._ttl._stopAfterCheck
  }
  clearInterval(db._ttl.intervalId)
  callback()
}

function ttlon (db, keys, ttl, callback) {
  if (!keys.length) return process.nextTick(callback)

  const exp = new Date(Date.now() + ttl)
  const batch = []
  const sub = db._ttl.sub
  const batchFn = (sub ? sub.batch.bind(sub) : db._ttl.batch)
  const encode = db._ttl.encoding.encode

  db._ttl._lock(keys, function (release) {
    callback = release(callback)
    ttloff(db, keys, function () {
      keys.forEach(function (key) {
        batch.push({ type: 'put', key: expiryKey(db, exp, key), value: encode(key) })
        batch.push({ type: 'put', key: prefixKey(db, key), value: encode(exp) })
      })

      batchFn(batch, { keyEncoding: 'binary', valueEncoding: 'binary' }, function (err) {
        if (err) { db.emit('error', err) }
        callback()
      })
    })
  })
}

function ttloff (db, keys, callback) {
  if (!keys.length) return process.nextTick(callback)

  const batch = []
  const sub = db._ttl.sub
  const getFn = (sub ? sub.get.bind(sub) : db.get.bind(db))
  const batchFn = (sub ? sub.batch.bind(sub) : db._ttl.batch)
  const decode = db._ttl.encoding.decode
  const done = after(keys.length, function (err) {
    if (err) db.emit('error', err)

    batchFn(batch, { keyEncoding: 'binary', valueEncoding: 'binary' }, function (err) {
      if (err) { db.emit('error', err) }
      callback()
    })
  })

  keys.forEach(function (key) {
    const prefixedKey = prefixKey(db, key)
    getFn(prefixedKey, { keyEncoding: 'binary', valueEncoding: 'binary' }, function (err, exp) {
      if (!err && exp) {
        batch.push({ type: 'del', key: expiryKey(db, decode(exp), key) })
        batch.push({ type: 'del', key: prefixedKey })
      }
      done(err && err.name !== 'NotFoundError' && err)
    })
  })
}

function put (db, key, value, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof callback !== 'function') {
    throw new Error('put() requires a callback argument')
  }

  options || (options = {})

  if (db._ttl.options.defaultTTL > 0 && !options.ttl && options.ttl !== 0) {
    options.ttl = db._ttl.options.defaultTTL
  }

  if (options.ttl > 0 && key != null && value != null) {
    // TODO: batch together with actual key
    return ttlon(db, [key], options.ttl, function (err) {
      if (err) return callback(err)

      db._ttl.put.call(db, key, value, options, callback)
    })
  }

  // TODO: remove existing TTL if any?
  db._ttl.put.call(db, key, value, options, callback)
}

function setTtl (db, key, ttl, callback) {
  if (ttl > 0 && key != null) {
    ttlon(db, [key], ttl, callback)
  }
}

function del (db, key, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof callback !== 'function') {
    throw new Error('del() requires a callback argument')
  }

  if (key != null) {
    // TODO: batch together with actual key
    // TODO: or even skip this, should get swept up anyway
    return ttloff(db, [key], function (err) {
      if (err) return callback(err)

      db._ttl.del.call(db, key, options, callback)
    })
  }

  db._ttl.del.call(db, key, options, callback)
}

function batch (db, arr, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof callback !== 'function') {
    throw new Error('batch() requires a callback argument')
  }

  options || (options = {})

  if (db._ttl.options.defaultTTL > 0 && !options.ttl && options.ttl !== 0) {
    options.ttl = db._ttl.options.defaultTTL
  }

  var done
  var on
  var off

  if (options.ttl > 0 && Array.isArray(arr)) {
    done = after(2, write)

    on = []
    off = []
    arr.forEach(function (entry) {
      if (!entry || entry.key == null) { return }

      if (entry.type === 'put' && entry.value != null) on.push(entry.key)
      if (entry.type === 'del') off.push(entry.key)
    })

    // TODO: batch could contain a key twice. perhaps do on and off sequentially.
    // TODO: better yet, perform both in one batch.
    ttlon(db, on, options.ttl, done)
    ttloff(db, off, done)
  } else {
    write()
  }

  function write (err) {
    if (err) return callback(err)

    db._ttl.batch.call(db, arr, options, callback)
  }
}

function close (db, callback) {
  if (typeof callback !== 'function') {
    throw new Error('close() requires a callback argument')
  }

  stopTtl(db, function () {
    if (db._ttl && typeof db._ttl.close === 'function') {
      return db._ttl.close.call(db, callback)
    }
    process.nextTick(callback)
  })
}

function setup (db, options) {
  if (db._ttl) return

  options || (options = {})

  options = xtend({
    methodPrefix: '',
    namespace: options.sub ? '' : 'ttl',
    expiryNamespace: 'x',
    separator: '!',
    checkFrequency: 10000,
    defaultTTL: 0
  }, options)

  const _prefixNs = options.namespace ? [options.namespace] : []

  db._ttl = {
    put: db.put.bind(db),
    del: db.del.bind(db),
    batch: db.batch.bind(db),
    close: db.close.bind(db),
    sub: options.sub,
    options: options,
    encoding: encoding.create(options),
    _prefixNs: _prefixNs,
    _expiryNs: _prefixNs.concat(options.expiryNamespace),
    _lock: new Lock()
  }

  db[options.methodPrefix + 'put'] = put.bind(null, db)
  db[options.methodPrefix + 'del'] = del.bind(null, db)
  db[options.methodPrefix + 'batch'] = batch.bind(null, db)
  db[options.methodPrefix + 'ttl'] = setTtl.bind(null, db)
  db[options.methodPrefix + 'stop'] = stopTtl.bind(null, db)
  // we must intercept close()
  db.close = close.bind(null, db)

  startTtl(db, options.checkFrequency)

  return db
}

module.exports = setup
