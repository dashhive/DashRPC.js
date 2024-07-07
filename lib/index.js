'use strict';

const promisify = require('util').promisify;
const http = require('http');
const https = require('https');

function RpcClient(opts) {
  opts = opts || {};
  this.host = opts.host || '127.0.0.1';
  this.port = opts.port || 9998;
  this.user = opts.user || 'user';
  this.pass = opts.pass || 'pass';
  this.timeout = opts.timeout;
  this.protocol = opts.protocol === 'http' ? http : https;
  this.batchedCalls = null;
  this.disableAgent = opts.disableAgent || false;
  this.onconnected = opts.onconnected;

  const isRejectUnauthorized = typeof opts.rejectUnauthorized !== 'undefined';
  this.rejectUnauthorized = isRejectUnauthorized ? opts.rejectUnauthorized : true;

  if (RpcClient.config.log) {
    this.log = RpcClient.config.log;
  } else {
    this.log = RpcClient.loggers[RpcClient.config.logger || 'normal'];
  }

  let chain = Promise.resolve();
  this.queue = {
    push: function (task) {
      const taskAsync = promisify(task);
      chain = chain.then(async function () {
        await taskAsync();
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

RpcClient.prototype._enqueue = function (request, callback) {
  /* jshint validthis: true */
  const self = this;
  const task = function (taskCallback) {
    const newCallback = function () {
      callback.apply(undefined, arguments);
      taskCallback();
    };
    self.request(request, newCallback);
  };

  self.queue.push(task);
};

RpcClient.prototype.request = function (request, callback) {
  /* jshint validthis: true */
  const self = this;
  const path = request.path;
  delete request.path;
  request = JSON.stringify(request);
  const authStr = `${self.user}:${self.pass}`;
  const auth = btoa(authStr);

  const options = {
    host: self.host,
    path,
    method: 'POST',
    port: self.port,
    rejectUnauthorized: self.rejectUnauthorized,
    agent: self.disableAgent ? false : undefined,
  };

  if (self.timeout) {
    options.timeout = self.timeout;
  }

  if (self.httpOptions) {
    Object.assign(options, self.httpOptions);
  }

  let called = false;

  const errorMessage = 'Dash JSON-RPC: ';

  const req = self.protocol.request(options, (res) => {
    let buf = '';
    res.on('data', (data) => {
      buf += data;
    });

    res.on('end', () => {
      if (called) {
        return;
      }
      called = true;

      if (res.statusCode === 401) {
        callback(new Error(`${errorMessage}Connection Rejected: 401 Unnauthorized`));
        return;
      }
      if (res.statusCode === 403) {
        callback(new Error(`${errorMessage}Connection Rejected: 403 Forbidden`));
        return;
      }
      if (res.statusCode === 403) {
        callback(new Error(`${errorMessage}Connection Rejected: 403 Forbidden`));
        return;
      }

      if (res.statusCode === 500 && buf.toString('utf8') === 'Work queue depth exceeded') {
        const exceededError = new Error(`Dash JSON-RPC: ${buf.toString('utf8')}`);
        exceededError.code = 429; // Too many requests
        callback(exceededError);
        return;
      }

      let parsedBuf;
      try {
        parsedBuf = JSON.parse(buf);
      } catch (e) {
        self.log.err(e.stack);
        self.log.err(buf);
        self.log.err(`HTTP Status code:${res.statusCode}`);
        const err = new Error(`${errorMessage}Error Parsing JSON: ${e.message}`);
        callback(err);
        return;
      }

      callback(parsedBuf.error, parsedBuf);
    });
  });

  req.on('error', (e) => {
    const err = new Error(`${errorMessage}Request Error: ${e.message}`);
    if (!called) {
      called = true;
      callback(err);
    }
  });

  req.on('timeout', () => {
    const err = new Error(`Timeout Error: ${options.timeout}ms exceeded`);
    called = true;
    callback(err);
  });

  req.setHeader('Content-Length', request.length);
  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Authorization', `Basic ${auth}`);
  req.write(request);
  req.end();
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
  this.batchedCalls = [];
  batchCallback();
  this._enqueue(this.batchedCalls, resultCallback);
  this.batchedCalls = null;
};

RpcClient.prototype.setTimeout = function (timeout) {
  this.timeout = timeout;
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

const slice = function (arr, start, end) {
  return Array.prototype.slice.call(arr, start, end);
};

RpcClient._generateMethods = function () {
  function createRPCMethod(methodName, argMap) {
    return function () {
      let path = '/';
      let slicedArguments = slice(arguments);

      const length = slicedArguments.length;

      // The last optional parameter of requested method is a wallet name. We don't want to pass it to core,
      // that's why we remove it. And since the latest parameter here is a callback, we use length - 2,
      // instead of length - 1
      if (length > 0 && typeof slicedArguments[length - 2] === 'object' && slicedArguments[length - 2].wallet) {
        path = '/wallet/' + slicedArguments[length - 2].wallet;
        slicedArguments.splice(length - 2, 1);
      }

      let limit = slicedArguments.length - 1;

      if (this.batchedCalls) {
        limit = slicedArguments.length;
      }

      for (let i = 0; i < limit; i += 1) {
        if (argMap[i]) {
          slicedArguments[i] = argMap[i](slicedArguments[i]);
        }
      }

      if (this.batchedCalls) {
        this.batchedCalls.push({
          path,
          jsonrpc: '2.0',
          method: methodName,
          params: slice(slicedArguments),
          id: getRandomId(),
        });
      } else {
        this._enqueue(
          {
            path,
            method: methodName,
            params: slice(slicedArguments, 0, slicedArguments.length - 1),
            id: getRandomId(),
          },
          arguments[arguments.length - 1],
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
