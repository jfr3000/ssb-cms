// mutant
require('setimmediate')
const h = require('mutant/html-element')
const MappedArray = require('mutant/mapped-array')
const MutantMap = require('mutant/map')
const Dict = require('mutant/dict')
const Value = require('mutant/value')
const Struct = require('mutant/struct')
const MutantArray = require('mutant/array')
const computed = require('mutant/computed')
const when = require('mutant/when')
const send = require('mutant/send')
const resolve = require('mutant/resolve')

const pull = require('pull-stream')
const prettyBytes = require('pretty-bytes')
const updates = require('./update-stream')
const config = require('../ssb-cms/config')
const {isDraft} = require('./util')

module.exports = function(ssb, drafts, root) {
  let draftCount = Value(0)
  let draftWarning = Value(false)

  let forkCount = Value(0)
  let incompleteCount = Value(0)
  let messageCount = Value(0)
  let revisionCount = Value(0)

  let blobRefs = Value(0)
  let blobsPresent = Value(0)
  let blobBytes = Value(0)

  function html() {
    return h('span.status', [
      h('span', [
        'Drafts:',
        h('span', draftCount),
        when(draftWarning, h('span', {title: 'draft db corruption'}, '⚠'))
      ]),
      h('span', [
        'Objects:',
        h('span', messageCount)
      ]),
      h('span', [
        'Revisions:',
        h('span', revisionCount)
      ]),
      h('span', [
        'Forks:',
        h('span', forkCount)
      ]),
      h('span', [
        'Incomplete:',
        h('span', incompleteCount)
      ]),
      h('span', [
        'Blobs:',
        h('span', [' ', blobsPresent, ' / ', blobRefs, ' (', computed([blobBytes], b => prettyBytes(b)), ')'])
      ])
    ])
  }

  function watchDrafts() {
    let seen = new Set()
    let counts = {
      draft: 0,
      branch: 0,
      revroot: 0
    }
    let synced = false
    pull(
      drafts.all({
        live: true,
        sync: true,
        keys: true
      }),
      pull.drain( (kv)=>{
        if (kv.sync) {
          draftCount.set(counts.draft)
          synced = true
          return
        }
        let key = kv.key
        //console.log('WATCH', kv.type, key)
        if (key[0]==='~') key = key.substr(1)
        let t = key.split(/[~-]/)[0].toLowerCase()
        if (t === 'draft') {
          if (!kv.type || kv.type == 'put') {
            if (!seen.has(kv.key)) {
              counts[t]++
              seen.add(kv.key)
            }
          } else if (kv.type == 'del') {
            counts[t]--
            seen.delete(kv.key)
          }
        } else {
          counts[t] += (kv.type === 'del') ? -1 : 1
        }
        if (synced) {
          draftCount.set(counts.draft)
          draftWarning.set(counts.draft !== counts.branch || counts.draft !== counts.revroot)
        }
      })
    )
  }

  function watchMessages(root) {
    let synced = false

    function f(obs) {
      let list = {}
      return function (key, state) {
        let dirty = false
        if (key && list[key] && !state) {
          list[key] = false
          dirty=true
        }
        if (key && !list[key] && state) {
          list[key] = true
          dirty = true
        }
        if (dirty && synced || !key) obs.set(Object.keys(list).length)
      }
    }

    let forked = f(forkCount)
    let incomplete = f(incompleteCount)
    let message = f(messageCount)
    let revision = f(revisionCount)

    pull(
      ssb.links({
        live: true,
        sync: true,
        rel: 'root',
        dest: root,
        keys: true,
        values: true
      }),
      pull.through( kv => revision(kv.key, true) ),
      updates({sync: true, bufferUntilSync: true}),
      pull.filter( x => {
        if (x.sync) {
          console.log('watch synced')
          synced = true
          // update observers
          forked()
          incomplete()
          message()
          revision()
        }
        return !x.sync
      }),

      pull.drain( kv => {
        //console.log('watch', kv)
        let {key, value} = kv
        if (kv.type === 'del') return
        if (isDraft(key)) return

        let content = value.content
        let revRoot = content && content.revisionRoot
        let revBranch = content && content.revisionBranch
        let isMessage = !revRoot || revRoot === key
        let isRevision = revBranch && revBranch !== revRoot
        
        forked(key, Object.keys(kv.heads).length > 1)
        incomplete(key, kv.tail !== key)
        message(key, isMessage)
      }, (err) => {
        console.log('status message stream ended', err)
      })
    )
  }

  function watchBlobs() {
    let synced = false
    let refs = 0
    let present = 0
    let totalSize = 0
    pull(
      ssb.links({
        live: true,
        sync: true,
        dest: '&'
      }),
      pull.filter( x => {
        if (x.sync) {
          console.log('blobs watch synced')
          synced = true
          blobRefs.set(refs)
          blobsPresent.set(present)
          blobBytes.set(totalSize)
        }
        return !x.sync
      }),
      pull.unique( x=>x.dest ),

      pull.drain( kv => {
        console.log('blobs watch', kv)
        refs++
        if (synced) {
          blobRefs.set(refs)
        }
        ssb.blobs.size(kv.dest, (err, size) => {
          console.log('blob size', kv.dest, err, size)
          if (!err) {
            present ++
            totalSize += size
            if (synced) {
              blobsPresent.set(present)
              blobBytes.set(totalSize)
            }
          }
        })
      }, (err) => {
        console.log('blobs stream ended', err)
      })
    )
  }

  watchDrafts()
  watchMessages(root)
  watchBlobs()

  return html()
}


module.exports.css = ()=>  `
  .menubar .status {
    display: flex;
    flex-direction: column;
    flex-wrap: wrap;
    height: 32px;
    font-size: 12px;
    padding-left: 1em;
  }
  .menubar .status>span {
    width: 100px;
    padding-right: 5px;
  }
`
