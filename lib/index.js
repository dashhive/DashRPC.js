'use strict';

function RpcClient(opts) {
  let rpc = this;

  opts = opts || {};
  rpc.host = opts.host || '127.0.0.1';
  rpc.port = opts.port || 9998;
  rpc.user = opts.user || 'user';
  rpc.pass = opts.pass || 'pass';
  rpc.timeout = opts.timeout;
  rpc.protocol = opts.protocol || 'https';
  rpc.batchedCalls = null;
  rpc.onconnected = opts.onconnected;

  if (RpcClient.config.log) {
    rpc.log = RpcClient.config.log;
  } else {
    rpc.log = RpcClient.loggers[RpcClient.config.logger || 'normal'];
  }
}

const cl = console.log.bind(console);

const noop = function () {};

RpcClient.E_IN_WARMUP = -28;

RpcClient.loggers = {
  none: {
    info: noop,
    warn: noop,
    err: noop,
    debug: noop,
  },
  normal: {
    info: cl,
    warn: cl,
    err: cl,
    debug: noop,
  },
  debug: {
    info: cl,
    warn: cl,
    err: cl,
    debug: cl,
  },
};

RpcClient.config = {
  logger: 'normal', // none, normal, debug,
};

RpcClient._getHeight = async function (rpc) {
  let warn = null;
  let tip = await rpc
    .getChainTips()
    //.getBestBlockHash()
    .then(function (result) {
      // { id, error, result }
      if (result.error) {
        // impossible, but we'll check anyway
        throw new Error(result.error);
      }

      if (!result.result?.[0].height) {
        // also impossible, and we still check anyway
        throw new Error('Sanity Fail: missing tip');
      }

      return result.result[0].height;
    })
    .catch(function (e) {
      if (e.code === RpcClient.E_IN_WARMUP) {
        warn = e;
        return 0;
      }

      throw e;
    });

  if (!rpc._connected) {
    rpc._connected = true;
    let onconnected = rpc.onconnected || RpcClient._onconnected;
    void onconnected.call(rpc, warn);
  }

  return tip;
};

RpcClient._onconnected = function () {
  let rpc = this;
  console.info(`[dashd-rpc] client connected to ${rpc.host}:${rpc.port}`);
};

/** @type {Object.<String, String>} */
RpcClient.callspec = {};
RpcClient.prototype.apiCalls = RpcClient.callspec;

function createProto(methodName, argTypeStr) {
  RpcClient.callspec[methodName] = argTypeStr;
  methodName = methodName.toLowerCase();

  let argTypes = argTypeStr.split(' ');

  async function callNamedRpc() {
    /* jshint validthis: true */
    let rpc = this;

    let path = '/';
    let args = Array.prototype.slice.call(arguments);

    // The last optional parameter of requested method is a wallet name,
    // which should not be passed via RPC, so we remove it.
    if (args.length > 0 && typeof args[args.length - 1] === 'object' && args[args.length - 1].wallet) {
      path = '/wallet/' + args[args.length - 1].wallet;
      args.splice(args.length - 1, 1);
    }

    let convertedArgs = [];
    for (let i = 0; i < args.length; i += 1) {
      let argType = argTypes[i];
      let convert = RpcClient._typeConverters[argType];
      if (!convert) {
        convert = RpcClient._typeConverters.str;
      }
      let arg = convert(args[i]);
      convertedArgs.push(arg);
    }

    if (!rpc.batchedCalls) {
      let data = await rpc.request({
        path,
        method: methodName,
        params: convertedArgs,
        id: getRandomId(),
      });
      return data;
    }

    rpc.batchedCalls.push({
      path,
      jsonrpc: '2.0',
      method: methodName,
      params: convertedArgs,
      id: getRandomId(),
    });
  }

  Object.assign(callNamedRpc, {
    method: methodName,
    callspec: argTypeStr,
  });
  return callNamedRpc;
}
RpcClient._createMethod = createProto;

RpcClient._typeConverters = {
  str: function (arg) {
    return arg.toString();
  },
  int: function (arg) {
    return parseFloat(arg);
  },
  int_str: function (arg) {
    if (typeof arg === 'number') {
      return parseFloat(arg);
    }

    return arg.toString();
  },
  float: function (arg) {
    return parseFloat(arg);
  },
  bool: function (arg) {
    return String(arg).toLowerCase() === 'true' || arg > 0;
  },
  obj: function (arg) {
    if (typeof arg === 'string') {
      return JSON.parse(arg);
    }
    return arg;
  },
};

RpcClient.prototype.request = async function (request) {
  /* jshint validthis: true */
  const rpc = this;
  const path = request.path;
  delete request.path;
  const body = JSON.stringify(request);
  const authStr = `${rpc.user}:${rpc.pass}`;
  const auth = btoa(authStr);

  const url = `${rpc.protocol}://${rpc.host}:${rpc.port}${path}`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: body,
  };

  if (rpc.timeout) {
    options.headersTimeout = rpc.timeout;
    options.keepAliveTimeout = rpc.timeout;
  }

  if (rpc.httpOptions) {
    Object.assign(options, rpc.httpOptions);
  }

  const errorMessage = 'Dash JSON-RPC';

  function wrapError(e) {
    const err = new Error(`${errorMessage}: Request Error: ${e.message}`);
    throw err;
  }

  let resp = await fetch(url, options).catch(wrapError);
  if (resp.status === 401) {
    throw new Error(`${errorMessage}: Connection Rejected: 401 Unnauthorized`);
  }
  if (resp.status === 403) {
    throw new Error(`${errorMessage}: Connection Rejected: 403 Forbidden`);
  }

  let data = await resp.text().catch(wrapError);
  if (resp.status === 500) {
    if (data === 'Work queue depth exceeded') {
      const exceededError = new Error(`${errorMessage}: : ${data}`);
      exceededError.code = 429; // Too many requests
      throw exceededError;
    }
  }

  let parsedBuf;
  try {
    parsedBuf = JSON.parse(data);
  } catch (e) {
    rpc.log.err(e.stack);
    rpc.log.err(data);
    rpc.log.err(`HTTP Status code:${resp.status}`);
    throw new Error(`${errorMessage}: Error Parsing JSON: ${e.message}`);
  }

  if (parsedBuf.error) {
    throw new Error(parsedBuf.error);
  }

  return parsedBuf;
};

RpcClient.prototype.init = async function (opts) {
  let rpc = this;
  rpc._connected = false;

  let retry = opts?.retry || 5000;

  let height = 0;
  for (;;) {
    height = await RpcClient._getHeight(rpc);
    if (height) {
      break;
    }
    await sleep(retry);
  }

  return height;
};

RpcClient.prototype.batch = async function (batchCallback) {
  let rpc = this;
  rpc.batchedCalls = [];
  batchCallback();
  let p = rpc.request(rpc.batchedCalls);
  rpc.batchedCalls = null;
  let data = await p;
  return data;
};

RpcClient.prototype.setTimeout = function (timeout) {
  let rpc = this;
  rpc.timeout = timeout;
};

// For definitions of RPC calls, see various files in: https://github.com/dashpay/dash/tree/master/src
RpcClient.prototype.abandonTransaction = createProto('abandonTransaction', 'str');
RpcClient.prototype.addMultiSigAddress = createProto('addMultiSigAddress', 'int str str');
RpcClient.prototype.addNode = createProto('addNode', 'str str');
RpcClient.prototype.backupWallet = createProto('backupWallet', 'str');
RpcClient.prototype.clearBanned = createProto('clearBanned', '');
RpcClient.prototype.createMultiSig = createProto('createMultiSig', 'int str');
RpcClient.prototype.createRawTransaction = createProto('createRawTransaction', 'str str int');
RpcClient.prototype.createWallet = createProto('createWallet', 'str bool bool str bool bool');
RpcClient.prototype.debug = createProto('debug', 'str');
RpcClient.prototype.decodeRawTransaction = createProto('decodeRawTransaction', 'str');
RpcClient.prototype.decodeScript = createProto('decodeScript', 'str');
RpcClient.prototype.disconnectNode = createProto('disconnectNode', 'str');
RpcClient.prototype.dumpPrivKey = createProto('dumpPrivKey', 'str');
RpcClient.prototype.dumpWallet = createProto('dumpWallet', 'str');
RpcClient.prototype.encryptWallet = createProto('encryptWallet', 'str');
RpcClient.prototype.estimateFee = createProto('estimateFee', 'int');
RpcClient.prototype.estimatePriority = createProto('estimatePriority', 'int');
RpcClient.prototype.estimateSmartFee = createProto('estimateSmartFee', 'int');
RpcClient.prototype.estimateSmartPriority = createProto('estimateSmartPriority', 'int');
RpcClient.prototype.fundRawTransaction = createProto('fundRawTransaction', 'str bool');
RpcClient.prototype.generate = createProto('generate', 'int');
RpcClient.prototype.generateToAddress = createProto('generateToAddress', 'int str');
RpcClient.prototype.getAccount = createProto('getAccount', 'str');
RpcClient.prototype.getAccountAddress = createProto('getAccountAddress', 'str');
RpcClient.prototype.getAddressMempool = createProto('getAddressMempool', 'obj');
RpcClient.prototype.getAddressUtxos = createProto('getAddressUtxos', 'obj');
RpcClient.prototype.getAddressBalance = createProto('getAddressBalance', 'obj');
RpcClient.prototype.getAddressDeltas = createProto('getAddressDeltas', 'obj');
RpcClient.prototype.getAddressTxids = createProto('getAddressTxids', 'obj');
RpcClient.prototype.getAddressesByAccount = createProto('getAddressesByAccount', '');
RpcClient.prototype.getAddedNodeInfo = createProto('getAddedNodeInfo', 'bool str');
RpcClient.prototype.getBalance = createProto('getBalance', 'str int bool');
RpcClient.prototype.getBestBlockHash = createProto('getBestBlockHash', '');
RpcClient.prototype.getBestChainLock = createProto('getBestChainLock', '');
RpcClient.prototype.getBlock = createProto('getBlock', 'str bool');
RpcClient.prototype.getBlockchainInfo = createProto('getBlockchainInfo', '');
RpcClient.prototype.getBlockCount = createProto('getBlockCount', '');
RpcClient.prototype.getBlockHashes = createProto('getBlockHashes', 'int int');
RpcClient.prototype.getBlockHash = createProto('getBlockHash', 'int');
RpcClient.prototype.getBlockHeader = createProto('getBlockHeader', 'str bool');
RpcClient.prototype.getBlockHeaders = createProto('getBlockHeaders', 'str int bool');
RpcClient.prototype.getBlockStats = createProto('getBlockStats', 'int_str obj');
RpcClient.prototype.getBlockTemplate = createProto('getBlockTemplate', '');
RpcClient.prototype.getConnectionCount = createProto('getConnectionCount', '');
RpcClient.prototype.getChainTips = createProto('getChainTips', 'int int');
RpcClient.prototype.getDifficulty = createProto('getDifficulty', '');
RpcClient.prototype.getGenerate = createProto('getGenerate', '');
RpcClient.prototype.getGovernanceInfo = createProto('getGovernanceInfo', '');
RpcClient.prototype.getInfo = createProto('getInfo', '');
RpcClient.prototype.getMemPoolInfo = createProto('getMemPoolInfo', '');
RpcClient.prototype.getMerkleBlocks = createProto('getMerkleBlocks', 'str str int');
RpcClient.prototype.getMiningInfo = createProto('getMiningInfo', '');
RpcClient.prototype.getNewAddress = createProto('getNewAddress', '');
RpcClient.prototype.getNetTotals = createProto('getNetTotals', '');
RpcClient.prototype.getNetworkInfo = createProto('getNetworkInfo', '');
RpcClient.prototype.getNetworkHashps = createProto('getNetworkHashps', 'int int');
RpcClient.prototype.getPeerInfo = createProto('getPeerInfo', '');
RpcClient.prototype.getPoolInfo = createProto('getPoolInfo', '');
RpcClient.prototype.getRawMemPool = createProto('getRawMemPool', 'bool');
RpcClient.prototype.getRawChangeAddress = createProto('getRawChangeAddress', '');
RpcClient.prototype.getRawTransaction = createProto('getRawTransaction', 'str bool');
RpcClient.prototype.getReceivedByAccount = createProto('getReceivedByAccount', 'str int');
RpcClient.prototype.getReceivedByAddress = createProto('getReceivedByAddress', 'str int');
RpcClient.prototype.getSpentInfo = createProto('getSpentInfo', 'obj');
RpcClient.prototype.getSuperBlockBudget = createProto('getSuperBlockBudget', 'int');
RpcClient.prototype.getTransaction = createProto('getTransaction', '');
RpcClient.prototype.getTxOut = createProto('getTxOut', 'str int bool');
RpcClient.prototype.getTxOutProof = createProto('getTxOutProof', 'str str');
RpcClient.prototype.getTxOutSetInfo = createProto('getTxOutSetInfo', '');
RpcClient.prototype.getWalletInfo = createProto('getWalletInfo', '');
RpcClient.prototype.help = createProto('help', 'str');
RpcClient.prototype.importAddress = createProto('importAddress', 'str str bool');
RpcClient.prototype.instantSendToAddress = createProto('instantSendToAddress', 'str int str str bool');
RpcClient.prototype.gobject = createProto('gobject', 'str str');
RpcClient.prototype.invalidateBlock = createProto('invalidateBlock', 'str');
RpcClient.prototype.importPrivKey = createProto('importPrivKey', 'str str bool');
RpcClient.prototype.importPubKey = createProto('importPubKey', 'str str bool');
RpcClient.prototype.importElectrumWallet = createProto('importElectrumWallet', 'str int');
RpcClient.prototype.importWallet = createProto('importWallet', 'str');
RpcClient.prototype.keyPoolRefill = createProto('keyPoolRefill', 'int');
RpcClient.prototype.listAccounts = createProto('listAccounts', 'int bool');
RpcClient.prototype.listAddressGroupings = createProto('listAddressGroupings', '');
RpcClient.prototype.listBanned = createProto('listBanned', '');
RpcClient.prototype.listReceivedByAccount = createProto('listReceivedByAccount', 'int bool');
RpcClient.prototype.listReceivedByAddress = createProto('listReceivedByAddress', 'int bool');
RpcClient.prototype.listSinceBlock = createProto('listSinceBlock', 'str int');
RpcClient.prototype.listTransactions = createProto('listTransactions', 'str int int bool');
RpcClient.prototype.listUnspent = createProto('listUnspent', 'int int str');
RpcClient.prototype.listLockUnspent = createProto('listLockUnspent', 'bool');
RpcClient.prototype.lockUnspent = createProto('lockUnspent', 'bool obj');
RpcClient.prototype.masternode = createProto('masternode', 'str');
RpcClient.prototype.masternodeBroadcast = createProto('masternodeBroadcast', 'str');
RpcClient.prototype.masternodelist = createProto('masternodelist', 'str str');
RpcClient.prototype.mnsync = createProto('mnsync', '');
RpcClient.prototype.move = createProto('move', 'str str float int str');
RpcClient.prototype.ping = createProto('ping', '');
RpcClient.prototype.prioritiseTransaction = createProto('prioritiseTransaction', 'str float int');
RpcClient.prototype.privateSend = createProto('privateSend', 'str');
RpcClient.prototype.protx = createProto('protx', 'str str str');
RpcClient.prototype.quorum = createProto('quorum', 'str int str str str str int');
RpcClient.prototype.reconsiderBlock = createProto('reconsiderBlock', 'str');
RpcClient.prototype.resendWalletTransactions = createProto('resendWalletTransactions', '');
RpcClient.prototype.sendFrom = createProto('sendFrom', 'str str float int str str');
RpcClient.prototype.sendMany = createProto('sendMany', 'str obj int str str bool bool');
RpcClient.prototype.sendRawTransaction = createProto('sendRawTransaction', 'str float bool');
RpcClient.prototype.sendToAddress = createProto('sendToAddress', 'str float str str');
RpcClient.prototype.sentinelPing = createProto('sentinelPing', 'str');
RpcClient.prototype.setAccount = createProto('setAccount', '');
RpcClient.prototype.setBan = createProto('setBan', 'str str int bool');
RpcClient.prototype.setGenerate = createProto('setGenerate', 'bool int');
RpcClient.prototype.setTxFee = createProto('setTxFee', 'float');
RpcClient.prototype.setMockTime = createProto('setMockTime', 'int');
RpcClient.prototype.spork = createProto('spork', 'str');
RpcClient.prototype.sporkupdate = createProto('sporkupdate', 'str int');
RpcClient.prototype.signMessage = createProto('signMessage', 'str str');
RpcClient.prototype.signRawTransaction = createProto('signRawTransaction', 'str str str str');
RpcClient.prototype.stop = createProto('stop', '');
RpcClient.prototype.submitBlock = createProto('submitBlock', 'str str');
RpcClient.prototype.validateAddress = createProto('validateAddress', 'str');
RpcClient.prototype.verifyMessage = createProto('verifyMessage', 'str str str');
RpcClient.prototype.verifyChain = createProto('verifyChain', 'int int');
RpcClient.prototype.verifyChainLock = createProto('verifyChainLock', 'str str int');
RpcClient.prototype.verifyIsLock = createProto('verifyIsLock', 'str str str int');
RpcClient.prototype.verifyTxOutProof = createProto('verifyTxOutProof', 'str');
RpcClient.prototype.voteRaw = createProto('voteRaw', 'str int');
RpcClient.prototype.waitForNewBlock = createProto('waitForNewBlock', 'int');
RpcClient.prototype.waitForBlockHeight = createProto('waitForBlockHeight', 'int int');
RpcClient.prototype.walletLock = createProto('walletLock', '');
RpcClient.prototype.walletPassPhrase = createProto('walletPassPhrase', 'str int bool');
RpcClient.prototype.walletPassphraseChange = createProto('walletPassphraseChange', 'str str');
RpcClient.prototype.getUser = createProto('getUser', 'str');

function getRandomId() {
  return parseInt(Math.random() * 100000);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

module.exports = RpcClient;
