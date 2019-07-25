const fs = require('fs')
const { promisify } = require('util')
const ethUtil = require('ethereumjs-util')
const Account = require('ethereumjs-account').default
const Trie = require('merkle-patricia-tree/secure')
const BN = ethUtil.BN
const testUtil = require('./util')
const { getRequiredForkConfigAlias } = require('./util')
const StateManager = require('../dist/state/stateManager').default
const yaml = require('js-yaml')
const rlp = require('rlp')

const VM = require('../dist/index.js').default
const PStateManager = require('../dist/state/promisified').default

async function runTestCase (options, testData, t) {
  let expectedPostStateRoot = testData.postStateRoot
  if (expectedPostStateRoot.substr(0, 2) === '0x') {
    expectedPostStateRoot = expectedPostStateRoot.substr(2)
  }

  // Prepare tx and block
  let tx = testUtil.makeTx(testData.transaction)
  let block = testUtil.makeBlockFromEnv(testData.env)
  tx._homestead = true
  tx.enableHomestead = true
  block.isHomestead = function () {
    return true
  }
  if (!tx.validate()) {
    return
  }

  let stateManager = new StateManager()
  await promisify(testUtil.setupPreConditions)(stateManager._trie, testData)
  const preStateRoot = stateManager._trie.root

  // Set up VM
  let vm = new VM({
    stateManager: stateManager,
    hardfork: options.forkConfig.toLowerCase()
  })
  if (options.jsontrace) {
    hookVM(vm, t)
  }

  // Determine set of all node hashes in the database
  // before running the tx.
  const existingKeys = new Set()
  const it = stateManager._trie.db.iterator()
  const next = promisify(it.next.bind(it))
  while (true) {
    const key = await next()
    if (!key) break
    existingKeys.add(key.toString('hex'))
  }

  // Hook leveldb.get and add any node that was fetched during execution
  // to a bag of proof nodes, under the condition that this node existed
  // before execution.
  const proofNodes = new Map()
  const getFunc = stateManager._trie.db.get.bind(stateManager._trie.db)
  stateManager._trie.db.get = (key, opts, cb) => {
    getFunc(key, opts, (err, v) => {
      if (!err && v) {
        if (existingKeys.has(key.toString('hex'))) {
          proofNodes.set(key.toString('hex'), v)
        }
      }
      cb(err, v)
    })
  }

  try {
    await vm.runTx({ tx: tx, block: block })
  } catch (err) {
    await deleteCoinbase(new PStateManager(stateManager), block.header.coinbase)
  }
  t.equal(stateManager._trie.root.toString('hex'), expectedPostStateRoot, 'the state roots should match')

  // Save bag of proof nodes to a new trie's underlying leveldb
  const trie = new Trie(null, preStateRoot)
  const opStack = []
  for (const [k, v] of proofNodes) {
    opStack.push({ type: 'put', key: Buffer.from(k, 'hex'), value: v })
  }
  await promisify(trie.db.batch.bind(trie.db))(opStack)

  stateManager = new StateManager({ trie: trie })
  vm = new VM({
    stateManager: stateManager,
    hardfork: options.forkConfig.toLowerCase()
  })
  if (options.jsontrace) {
    hookVM(vm, t)
  }
  try {
    await vm.runTx({ tx: tx, block: block })
  } catch (err) {
    await deleteCoinbase(new PStateManager(stateManager), block.header.coinbase)
  }
  t.equal(stateManager._trie.root.toString('hex'), expectedPostStateRoot, 'the state roots should match')

  return {
    preStateRoot,
    tx,
    block,
    proofNodes: Array.from(proofNodes.values()),
    postStateRoot: Buffer.from(expectedPostStateRoot, 'hex')
  }
}

/*
 * If tx is invalid and coinbase is empty, the test harness
 * expects the coinbase account to be deleted from state.
 * Without this ecmul_0-3_5616_28000_96 would fail.
 */
async function deleteCoinbase (pstate, coinbaseAddr) {
  const account = await pstate.getAccount(coinbaseAddr)
  if (new BN(account.balance).isZero()) {
    await pstate.putAccount(coinbaseAddr, new Account())
    await pstate.cleanupTouchedAccounts()
    await promisify(pstate._wrapped._cache.flush.bind(pstate._wrapped._cache))()
  }
}

function hookVM (vm, t) {
  vm.on('step', function (e) {
    let hexStack = []
    hexStack = e.stack.map(item => {
      return '0x' + new BN(item).toString(16, 0)
    })

    var opTrace = {
      'pc': e.pc,
      'op': e.opcode.opcode,
      'gas': '0x' + e.gasLeft.toString('hex'),
      'gasCost': '0x' + e.opcode.fee.toString(16),
      'stack': hexStack,
      'depth': e.depth,
      'opName': e.opcode.name
    }

    t.comment(JSON.stringify(opTrace))
  })
  vm.on('afterTx', function (results) {
    let stateRoot = {
      'stateRoot': vm.stateManager._trie.root.toString('hex')
    }
    t.comment(JSON.stringify(stateRoot))
  })
}

function parseTestCases (forkConfig, testData, data, gasLimit, value) {
  let testCases = []
  if (testData['post'][forkConfig]) {
    testCases = testData['post'][forkConfig].map(testCase => {
      let testIndexes = testCase['indexes']
      let tx = { ...testData.transaction }
      if (data !== undefined && testIndexes['data'] !== data) {
        return null
      }

      if (value !== undefined && testIndexes['value'] !== value) {
        return null
      }

      if (gasLimit !== undefined && testIndexes['gas'] !== gasLimit) {
        return null
      }

      tx.data = testData.transaction.data[testIndexes['data']]
      tx.gasLimit = testData.transaction.gasLimit[testIndexes['gas']]
      tx.value = testData.transaction.value[testIndexes['value']]
      return {
        'transaction': tx,
        'postStateRoot': testCase['hash'],
        'env': testData['env'],
        'pre': testData['pre']
      }
    })
  }

  testCases = testCases.filter(testCase => {
    return testCase != null
  })

  return testCases
}

function encodeBlockData (tx, proofNodes) {
  return rlp.encode([
    [tx.getSenderAddress(), tx.nonce, tx.gasPrice, tx.gasLimit, tx.to, tx.value, tx.data],
    proofNodes
  ])
}

function writeToYaml (name, preStateRoot, blockData, postStateRoot) {
  const testSuite = {
    'beacon_state': {
      'execution_scripts': [
        'target/wasm32-unknown-unknown/release/smpt.wasm'
      ]
    },
    'shard_pre_state': {
      'exec_env_states': [
        preStateRoot.toString('hex')
      ]
    },
    'shard_blocks': [
      {
        'env': 0,
        'data': blockData.toString('hex')
      }
    ],
    'shard_post_state': {
      'exec_env_states': [
        postStateRoot.toString('hex')
      ]
    }
  }
  const serializedTestSuite = yaml.safeDump(testSuite)
  fs.writeFileSync(name + '.yaml', serializedTestSuite)
}

module.exports = async function runStateTest (options, testData, testName, t) {
  const forkConfig = getRequiredForkConfigAlias(options.forkConfig)
  try {
    const testCases = parseTestCases(forkConfig, testData, options.data, options.gasLimit, options.value)
    if (testCases.length > 0) {
      let i = 0
      for (const testCase of testCases) {
        const res = await runTestCase(options, testCase, t)
        if (options.scout) {
          console.log('Number of proof nodes:', res.proofNodes.length)
          const blockData = encodeBlockData(res.tx, res.proofNodes)
          console.log('Block data length:', blockData.byteLength)
          writeToYaml(testName + '-' + i, res.preStateRoot, blockData, res.postStateRoot)
        }
        i++
      }
    } else {
      t.comment(`No ${forkConfig} post state defined, skip test`)
      return
    }
  } catch (e) {
    t.fail('error running test case for fork: ' + forkConfig)
    console.log('error:', e)
  }
}
