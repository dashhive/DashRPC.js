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

  let chain = Promise.resolve();
  rpc.queue = {
    push: function (runTask) {
      chain = chain.then(async function () {
        await runTask();
      });
    },
  };
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

RpcClient.prototype._enqueue = async function (request, callback) {
  /* jshint validthis: true */
  let rpc = this;

  async function runTask() {
    await rpc
      .request(request)
      .then(function (data) {
        callback(null, data);
      })
      .catch(function (err) {
        callback(err);
      });
  }

  rpc.queue.push(runTask);
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

RpcClient.prototype.batch = function (batchCallback, resultCallback) {
  let rpc = this;
  rpc.batchedCalls = [];
  batchCallback();
  rpc._enqueue(rpc.batchedCalls, resultCallback);
  rpc.batchedCalls = null;
};

RpcClient.prototype.setTimeout = function (timeout) {
  let rpc = this;
  rpc.timeout = timeout;
};

// For definitions of RPC calls, see various files in: https://github.com/dashpay/dash/tree/master/src
RpcClient.callspec = {
  abandonTransaction: 'str',
  addMultiSigAddress: 'int str str',
  addNode: 'str str',
  backupWallet: 'str',
  clearBanned: '',
  createMultiSig: 'int str',
  createRawTransaction: 'str str int',
  createWallet: 'str bool bool str bool bool',
  debug: 'str',
  decodeRawTransaction: 'str',
  decodeScript: 'str',
  disconnectNode: 'str',
  dumpPrivKey: 'str',
  dumpWallet: 'str',
  encryptWallet: 'str',
  estimateFee: 'int',
  estimatePriority: 'int',
  estimateSmartFee: 'int',
  estimateSmartPriority: 'int',
  fundRawTransaction: 'str bool',
  generate: 'int',
  generateToAddress: 'int str',
  getAccount: 'str',
  getAccountAddress: 'str',
  getAddressMempool: 'obj',
  getAddressUtxos: 'obj',
  getAddressBalance: 'obj',
  getAddressDeltas: 'obj',
  getAddressTxids: 'obj',
  getAddressesByAccount: '',
  getAddedNodeInfo: 'bool str',
  getBalance: 'str int bool',
  getBestBlockHash: '',
  getBestChainLock: '',
  getBlock: 'str bool',
  getBlockchainInfo: '',
  getBlockCount: '',
  getBlockHashes: 'int int',
  getBlockHash: 'int',
  getBlockHeader: 'str bool',
  getBlockHeaders: 'str int bool',
  getBlockStats: 'int_str obj',
  getBlockTemplate: '',
  getConnectionCount: '',
  getChainTips: 'int int',
  getDifficulty: '',
  getGenerate: '',
  getGovernanceInfo: '',
  getInfo: '',
  getMemPoolInfo: '',
  getMerkleBlocks: 'str str int',
  getMiningInfo: '',
  getNewAddress: '',
  getNetTotals: '',
  getNetworkInfo: '',
  getNetworkHashps: 'int int',
  getPeerInfo: '',
  getPoolInfo: '',
  getRawMemPool: 'bool',
  getRawChangeAddress: '',
  getRawTransaction: 'str bool',
  getReceivedByAccount: 'str int',
  getReceivedByAddress: 'str int',
  getSpentInfo: 'obj',
  getSuperBlockBudget: 'int',
  getTransaction: '',
  getTxOut: 'str int bool',
  getTxOutProof: 'str str',
  getTxOutSetInfo: '',
  getWalletInfo: '',
  help: 'str',
  importAddress: 'str str bool',
  instantSendToAddress: 'str int str str bool',
  gobject: 'str str',
  invalidateBlock: 'str',
  importPrivKey: 'str str bool',
  importPubKey: 'str str bool',
  importElectrumWallet: 'str int',
  importWallet: 'str',
  keyPoolRefill: 'int',
  listAccounts: 'int bool',
  listAddressGroupings: '',
  listBanned: '',
  listReceivedByAccount: 'int bool',
  listReceivedByAddress: 'int bool',
  listSinceBlock: 'str int',
  listTransactions: 'str int int bool',
  listUnspent: 'int int str',
  listLockUnspent: 'bool',
  lockUnspent: 'bool obj',
  masternode: 'str',
  masternodeBroadcast: 'str',
  masternodelist: 'str str',
  mnsync: '',
  move: 'str str float int str',
  ping: '',
  prioritiseTransaction: 'str float int',
  privateSend: 'str',
  protx: 'str str str',
  quorum: 'str int str str str str int',
  reconsiderBlock: 'str',
  resendWalletTransactions: '',
  sendFrom: 'str str float int str str',
  sendMany: 'str obj int str str bool bool',
  sendRawTransaction: 'str float bool',
  sendToAddress: 'str float str str',
  sentinelPing: 'str',
  setAccount: '',
  setBan: 'str str int bool',
  setGenerate: 'bool int',
  setTxFee: 'float',
  setMockTime: 'int',
  spork: 'str',
  sporkupdate: 'str int',
  signMessage: 'str str',
  signRawTransaction: 'str str str str',
  stop: '',
  submitBlock: 'str str',
  validateAddress: 'str',
  verifyMessage: 'str str str',
  verifyChain: 'int int',
  verifyChainLock: 'str str int',
  verifyIsLock: 'str str str int',
  verifyTxOutProof: 'str',
  voteRaw: 'str int',
  waitForNewBlock: 'int',
  waitForBlockHeight: 'int int',
  walletLock: '',
  walletPassPhrase: 'str int bool',
  walletPassphraseChange: 'str str',
  getUser: 'str',
};

RpcClient._generateMethods = function () {
  function createRPCMethod(methodName, argMap) {
    return function () {
      let rpc = this;

      let path = '/';
      let slicedArguments = Array.prototype.slice.call(arguments);

      const length = slicedArguments.length;

      // The last optional parameter of requested method is a wallet name. We don't want to pass it to core,
      // that's why we remove it. And since the latest parameter here is a callback, we use length - 2,
      // instead of length - 1
      if (length > 0 && typeof slicedArguments[length - 2] === 'object' && slicedArguments[length - 2].wallet) {
        path = '/wallet/' + slicedArguments[length - 2].wallet;
        slicedArguments.splice(length - 2, 1);
      }

      let limit = slicedArguments.length - 1;

      if (rpc.batchedCalls) {
        limit = slicedArguments.length;
      }

      for (let i = 0; i < limit; i += 1) {
        if (argMap[i]) {
          slicedArguments[i] = argMap[i](slicedArguments[i]);
        }
      }

      if (rpc.batchedCalls) {
        rpc.batchedCalls.push({
          path,
          jsonrpc: '2.0',
          method: methodName,
          params: slicedArguments.slice(0),
          id: getRandomId(),
        });
      } else {
        let callback = arguments[arguments.length - 1];
        rpc._enqueue(
          {
            path,
            method: methodName,
            params: slicedArguments.slice(0, slicedArguments.length - 1),
            id: getRandomId(),
          },
          callback,
        );
      }
    };
  }

  const types = {
    str(arg) {
      return arg.toString();
    },
    int(arg) {
      return parseFloat(arg);
    },
    int_str(arg) {
      if (typeof arg === 'number') {
        return parseFloat(arg);
      }

      return arg.toString();
    },
    float(arg) {
      return parseFloat(arg);
    },
    bool(arg) {
      return String(arg).toLowerCase() === 'true' || arg > 0;
    },
    obj(arg) {
      if (typeof arg === 'string') {
        return JSON.parse(arg);
      }
      return arg;
    },
  };

  let commandNames = Object.keys(RpcClient.callspec);
  for (const k of commandNames) {
    const spec = RpcClient.callspec[k].split(' ');
    for (let i = 0; i < spec.length; i += 1) {
      if (types[spec[i]]) {
        spec[i] = types[spec[i]];
      } else {
        spec[i] = types.str;
      }
    }
    const methodName = k.toLowerCase();
    RpcClient.prototype[k] = createRPCMethod(methodName, spec);
    RpcClient.prototype[methodName] = RpcClient.prototype[k];
  }

  RpcClient.prototype.apiCalls = RpcClient.callspec;
};

function getRandomId() {
  return parseInt(Math.random() * 100000);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

RpcClient._generateMethods();

module.exports = RpcClient;
