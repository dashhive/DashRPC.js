/**
 * @typedef DashRPC
 * @prop {Int16} E_IN_WARMUP
 * @prop {DashRPCCreate} create
 * @prop {Object.<String, Function>} _typeConverters
 * @prop {DashRPCSplicePathFromExtras} _splicePathFromExtras
 * @prop {DashRPCConvertArgsTypes} _convertArgsTypes
 */

/**
 * @callback DashRPCCreate
 * @param {DashRPCOptions} opts
 */

/**
 * @typedef DashRPCOptions
 * @prop {String} [host]
 * @prop {Uint16} [port]
 * @prop {String} [user]
 * @prop {String} [pass]
 * @prop {Number} [timeout]
 * @prop {String} [protocol]
 * @prop {DashRPCOnconnected} [onconnected]
 * @prop {any} [httpOptions]
 */

/**
 * @callback DashRPCOnconnected
 * @param {Error?} [err]
 */

/**
 * @typedef DashRPCRequest
 * @prop {String} method - rpc call names
 * @prop {Array<String|Number|Boolean|null>} params - same as the cli arguments
 * @prop {Uint32} [id] - a random id between 0 and 100000
 */

/**
 * @callback DashRPCSplicePathFromExtras
 * @param {Array<any>?} [extras]
 * @returns {String}
 */

/**
 * @callback DashRPCConvertArgsTypes
 * @param {Array<String>} argTypes
 * @param {Array<any>} args
 */

/** @type {DashRPC} */
//@ts-ignore
var DashRpc = ('object' === typeof module && exports) || {};
(function (window, DashRpc) {
  'use strict';
  /* jshint maxstatements: 1000 */

  DashRpc.E_IN_WARMUP = -28;

  DashRpc.create = function (opts) {
    let rpc = {};

    if (!opts) {
      opts = Object.assign({});
    }
    rpc.host = opts.host || '127.0.0.1';
    rpc.port = opts.port || 9998;
    rpc.user = opts.user || 'user';
    rpc.pass = opts.pass || 'pass';
    rpc.timeout = opts.timeout;
    rpc.protocol = opts.protocol || 'https';
    rpc.onconnected = opts.onconnected;
    rpc._connected = false;
    rpc.httpOptions = opts.httpOptions || {};

    rpc._getHeight = async function () {
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
          if (e.code === DashRpc.E_IN_WARMUP) {
            warn = e;
            return 0;
          }

          throw e;
        });

      if (!rpc._connected) {
        rpc._connected = true;
        let onconnected = rpc.onconnected || rpc._onconnected;
        void onconnected.call(rpc, warn);
      }

      return tip;
    };

    rpc._onconnected = function () {
      console.info(`[DashRpc] client connected to ${rpc.host}:${rpc.port}`);
    };

    /**
     * @param {String} path - either '/' or '/wallet/<name>'
     * @param {DashRPCRequest} request
     */
    rpc.request = async function (path, request) {
      if (!request.id) {
        request.id = getRandomId();
      }

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
        Object.assign(options, {
          headersTimeout: rpc.timeout,
          keepAliveTimeout: rpc.timeout,
        });
      }

      if (rpc.httpOptions) {
        Object.assign(options, rpc.httpOptions);
      }

      /**
       * @param {Error} e
       */
      function wrapError(e) {
        const err = new Error(`[DashRpc] Request Error: ${e.message}`);
        throw err;
      }

      /** @type {Response} */
      //@ts-ignore
      let resp = await fetch(url, options).catch(wrapError);
      if (resp.status === 401) {
        throw new Error(`[DashRpc] Connection Rejected: 401 Unnauthorized`);
      }
      if (resp.status === 403) {
        throw new Error(`[DashRpc] Connection Rejected: 403 Forbidden`);
      }

      /** @type {String} */
      //@ts-ignore
      let data = await resp.text().catch(wrapError);
      if (resp.status === 500) {
        if (data === 'Work queue depth exceeded') {
          const exceededError = new Error(`[DashRpc] ${data}`);
          Object.assign(exceededError, {
            code: 429, // Too many requests
          });
          throw exceededError;
        }
      }

      let parsedBuf;
      try {
        parsedBuf = JSON.parse(data);
      } catch (e) {
        //@ts-ignore
        let message = e.message;
        let err = new Error(`[DashRpc] HTTP ${resp.status}: Error Parsing JSON: ${message}`);
        Object.assign(err, {
          data: data,
        });
        throw err;
      }

      if (parsedBuf.error) {
        let err = new Error(parsedBuf.error.message);
        Object.assign(err, parsedBuf.error);
        throw err;
      }

      return parsedBuf;
    };

    /**
     * @param {String} method
     * @param {String} argTypesStr
     * @param {...any} args
     */
    rpc._wrapRequest = async function (method, argTypesStr, ...args) {
      method = method.toLowerCase();
      let argTypes = argTypesStr.split(' ');

      let path = DashRpc._splicePathFromExtras(args); // may args.splice(-1, 1)
      let params = DashRpc._convertArgsTypes(argTypes, args);

      let data = await rpc.request(path, {
        method,
        params,
      });
      return data;
    };

    /**
     * @param {Object} opts
     * @param {Uint53} [opts.retry] - ms delay before retry
     */
    rpc.init = async function (opts) {
      rpc._connected = false;

      let retry = opts?.retry || 5000;

      let height = 0;
      for (;;) {
        height = await rpc._getHeight();
        if (height) {
          break;
        }
        await sleep(retry);
      }

      return height;
    };

    // For definitions of RPC calls, see various files in:
    // https://github.com/dashpay/dash/tree/master/src
    rpc.abandonTransaction = createProto('abandonTransaction', 'str');
    rpc.addMultiSigAddress = createProto('addMultiSigAddress', 'int str str');
    rpc.addNode = createProto('addNode', 'str str');
    rpc.backupWallet = createProto('backupWallet', 'str');
    rpc.clearBanned = createProto('clearBanned', '');
    rpc.createMultiSig = createProto('createMultiSig', 'int str');
    rpc.createRawTransaction = createProto('createRawTransaction', 'str str int');
    rpc.createWallet = createProto('createWallet', 'str bool bool str bool bool');
    rpc.debug = createProto('debug', 'str');
    rpc.decodeRawTransaction = createProto('decodeRawTransaction', 'str');
    rpc.decodeScript = createProto('decodeScript', 'str');
    rpc.disconnectNode = createProto('disconnectNode', 'str');
    rpc.dumpPrivKey = createProto('dumpPrivKey', 'str');
    rpc.dumpWallet = createProto('dumpWallet', 'str');
    rpc.encryptWallet = createProto('encryptWallet', 'str');
    rpc.estimateFee = createProto('estimateFee', 'int');
    rpc.estimatePriority = createProto('estimatePriority', 'int');
    rpc.estimateSmartFee = createProto('estimateSmartFee', 'int');
    rpc.estimateSmartPriority = createProto('estimateSmartPriority', 'int');
    rpc.fundRawTransaction = createProto('fundRawTransaction', 'str bool');
    rpc.generate = createProto('generate', 'int');
    rpc.generateToAddress = createProto('generateToAddress', 'int str');
    rpc.getAccount = createProto('getAccount', 'str');
    rpc.getAccountAddress = createProto('getAccountAddress', 'str');
    rpc.getAddressMempool = createProto('getAddressMempool', 'obj');
    rpc.getAddressUtxos = createProto('getAddressUtxos', 'obj');
    rpc.getAddressBalance = createProto('getAddressBalance', 'obj');
    rpc.getAddressDeltas = createProto('getAddressDeltas', 'obj');
    rpc.getAddressTxids = createProto('getAddressTxids', 'obj');
    rpc.getAddressesByAccount = createProto('getAddressesByAccount', '');
    rpc.getAddedNodeInfo = createProto('getAddedNodeInfo', 'bool str');
    rpc.getBalance = createProto('getBalance', 'str int bool');
    rpc.getBestBlockHash = createProto('getBestBlockHash', '');
    rpc.getBestChainLock = createProto('getBestChainLock', '');
    rpc.getBlock = createProto('getBlock', 'str bool');
    rpc.getBlockchainInfo = createProto('getBlockchainInfo', '');
    rpc.getBlockCount = createProto('getBlockCount', '');
    rpc.getBlockHashes = createProto('getBlockHashes', 'int int');
    rpc.getBlockHash = createProto('getBlockHash', 'int');
    rpc.getBlockHeader = createProto('getBlockHeader', 'str bool');
    rpc.getBlockHeaders = createProto('getBlockHeaders', 'str int bool');
    rpc.getBlockStats = createProto('getBlockStats', 'int_str obj');
    rpc.getBlockTemplate = createProto('getBlockTemplate', '');
    rpc.getConnectionCount = createProto('getConnectionCount', '');
    rpc.getChainTips = createProto('getChainTips', 'int int');
    rpc.getDifficulty = createProto('getDifficulty', '');
    rpc.getGenerate = createProto('getGenerate', '');
    rpc.getGovernanceInfo = createProto('getGovernanceInfo', '');
    rpc.getInfo = createProto('getInfo', '');
    rpc.getMemPoolInfo = createProto('getMemPoolInfo', '');
    rpc.getMerkleBlocks = createProto('getMerkleBlocks', 'str str int');
    rpc.getMiningInfo = createProto('getMiningInfo', '');
    rpc.getNewAddress = createProto('getNewAddress', '');
    rpc.getNetTotals = createProto('getNetTotals', '');
    rpc.getNetworkInfo = createProto('getNetworkInfo', '');
    rpc.getNetworkHashps = createProto('getNetworkHashps', 'int int');
    rpc.getPeerInfo = createProto('getPeerInfo', '');
    rpc.getPoolInfo = createProto('getPoolInfo', '');
    rpc.getRawMemPool = createProto('getRawMemPool', 'bool');
    rpc.getRawChangeAddress = createProto('getRawChangeAddress', '');
    rpc.getRawTransaction = createProto('getRawTransaction', 'str bool');
    rpc.getReceivedByAccount = createProto('getReceivedByAccount', 'str int');
    rpc.getReceivedByAddress = createProto('getReceivedByAddress', 'str int');
    rpc.getSpentInfo = createProto('getSpentInfo', 'obj');
    rpc.getSuperBlockBudget = createProto('getSuperBlockBudget', 'int');
    rpc.getTransaction = createProto('getTransaction', '');
    rpc.getTxOut = createProto('getTxOut', 'str int bool');
    rpc.getTxOutProof = createProto('getTxOutProof', 'str str');
    rpc.getTxOutSetInfo = createProto('getTxOutSetInfo', '');
    rpc.getWalletInfo = createProto('getWalletInfo', '');
    rpc.help = createProto('help', 'str');
    rpc.importAddress = createProto('importAddress', 'str str bool');
    rpc.instantSendToAddress = createProto('instantSendToAddress', 'str int str str bool');
    rpc.gobject = createProto('gobject', 'str str');
    rpc.invalidateBlock = createProto('invalidateBlock', 'str');
    rpc.importPrivKey = createProto('importPrivKey', 'str str bool');
    rpc.importPubKey = createProto('importPubKey', 'str str bool');
    rpc.importElectrumWallet = createProto('importElectrumWallet', 'str int');
    rpc.importWallet = createProto('importWallet', 'str');
    rpc.keyPoolRefill = createProto('keyPoolRefill', 'int');
    rpc.listAccounts = createProto('listAccounts', 'int bool');
    rpc.listAddressGroupings = createProto('listAddressGroupings', '');
    rpc.listBanned = createProto('listBanned', '');
    rpc.listReceivedByAccount = createProto('listReceivedByAccount', 'int bool');
    rpc.listReceivedByAddress = createProto('listReceivedByAddress', 'int bool');
    rpc.listSinceBlock = createProto('listSinceBlock', 'str int');
    rpc.listTransactions = createProto('listTransactions', 'str int int bool');
    rpc.listUnspent = createProto('listUnspent', 'int int str');
    rpc.listLockUnspent = createProto('listLockUnspent', 'bool');
    rpc.lockUnspent = createProto('lockUnspent', 'bool obj');
    rpc.masternode = createProto('masternode', 'str');
    rpc.masternodeBroadcast = createProto('masternodeBroadcast', 'str');
    rpc.masternodelist = createProto('masternodelist', 'str str');
    rpc.mnsync = createProto('mnsync', '');
    rpc.move = createProto('move', 'str str float int str');
    rpc.ping = createProto('ping', '');
    rpc.prioritiseTransaction = createProto('prioritiseTransaction', 'str float int');
    rpc.privateSend = createProto('privateSend', 'str');
    rpc.protx = createProto('protx', 'str str str');
    rpc.quorum = createProto('quorum', 'str int str str str str int');
    rpc.reconsiderBlock = createProto('reconsiderBlock', 'str');
    rpc.resendWalletTransactions = createProto('resendWalletTransactions', '');
    rpc.sendFrom = createProto('sendFrom', 'str str float int str str');
    rpc.sendMany = createProto('sendMany', 'str obj int str str bool bool');
    rpc.sendRawTransaction = createProto('sendRawTransaction', 'str float bool');
    rpc.sendToAddress = createProto('sendToAddress', 'str float str str');
    rpc.sentinelPing = createProto('sentinelPing', 'str');
    rpc.setAccount = createProto('setAccount', '');
    rpc.setBan = createProto('setBan', 'str str int bool');
    rpc.setGenerate = createProto('setGenerate', 'bool int');
    rpc.setTxFee = createProto('setTxFee', 'float');
    rpc.setMockTime = createProto('setMockTime', 'int');
    rpc.spork = createProto('spork', 'str');
    rpc.sporkupdate = createProto('sporkupdate', 'str int');
    rpc.signMessage = createProto('signMessage', 'str str');
    rpc.signRawTransaction = createProto('signRawTransaction', 'str str str str');
    rpc.stop = createProto('stop', '');
    rpc.submitBlock = createProto('submitBlock', 'str str');
    rpc.validateAddress = createProto('validateAddress', 'str');
    rpc.verifyMessage = createProto('verifyMessage', 'str str str');
    rpc.verifyChain = createProto('verifyChain', 'int int');
    rpc.verifyChainLock = createProto('verifyChainLock', 'str str int');
    rpc.verifyIsLock = createProto('verifyIsLock', 'str str str int');
    rpc.verifyTxOutProof = createProto('verifyTxOutProof', 'str');
    rpc.voteRaw = createProto('voteRaw', 'str int');
    rpc.waitForNewBlock = createProto('waitForNewBlock', 'int');
    rpc.waitForBlockHeight = createProto('waitForBlockHeight', 'int int');
    rpc.walletLock = createProto('walletLock', '');
    rpc.walletPassPhrase = createProto('walletPassPhrase', 'str int bool');
    rpc.walletPassphraseChange = createProto('walletPassphraseChange', 'str str');
    rpc.getUser = createProto('getUser', 'str');

    /**
     * @param {String} methodName
     * @param {String} argTypesStr - ex: 'int bool str'
     */
    function createProto(methodName, argTypesStr) {
      /**
       * @param {...any} args
       */
      async function callNamedRpc(...args) {
        let data = await rpc._wrapRequest(methodName, argTypesStr, ...args);
        return data;
      }
      return callNamedRpc;
    }

    return rpc;
  };

  DashRpc._typeConverters = {
    /** @param {String|Number|Boolean} arg */
    str: function (arg) {
      return arg.toString();
    },
    /** @param {String|Number} arg */
    int: function (arg) {
      if (typeof arg === 'number') {
        return arg;
      }
      return parseFloat(arg);
    },
    /** @param {String|Number} arg */
    int_str: function (arg) {
      if (typeof arg === 'number') {
        return Math.round(arg);
      }

      return arg.toString();
    },
    /** @param {String|Number} arg */
    float: function (arg) {
      if (typeof arg === 'number') {
        return arg;
      }
      return parseFloat(arg);
    },
    /** @param {Boolean|String|Number} arg */
    bool: function (arg) {
      if (typeof arg === 'boolean') {
        return arg;
      }

      if (typeof arg === 'number') {
        return arg > 0;
      }

      return String(arg).toLowerCase() === 'true';
    },
    /** @param {Object|String|Number|Boolean} arg */
    obj: function (arg) {
      if (typeof arg === 'string') {
        return JSON.parse(arg);
      }
      return arg;
    },
  };

  DashRpc._convertArgsTypes = function (argTypes, args) {
    args = args.slice(0);

    let len = Math.min(argTypes.length, args.length);
    for (let i = 0; i < len; i += 1) {
      let argType = argTypes[i];
      let convert = DashRpc._typeConverters[argType];
      if (!convert) {
        convert = DashRpc._typeConverters.str;
      }
      let arg = convert(args[i]);
      args[i] = arg;
    }

    return args;
  };

  /**
   * The last optional parameter of requested method is a wallet name,
   * which should not be passed via RPC, so we remove it.
   */
  DashRpc._splicePathFromExtras = function (extras) {
    let path = '/';
    if (!extras) {
      return path;
    }

    let lastIndex = extras.length - 1;
    let last = extras[lastIndex];
    if (last?.wallet) {
      extras.splice(lastIndex, 1);
      path = `/wallet/${last.wallet}`;
    }

    return path;
  };

  /**
   * @returns {Uint32}
   */
  function getRandomId() {
    let f64 = Math.random() * 100000;
    let i32 = Math.round(f64);
    return i32;
  }

  /**
   * @param {Uint53} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // @ts-ignore
  window.DashRpc = DashRpc;
})(('object' === typeof window && window) || {}, DashRpc);
if ('object' === typeof module) {
  module.exports = DashRpc;
}

/** @typedef {Number} Uint53 */
/** @typedef {Number} Uint32 */
/** @typedef {Number} Uint16 */
/** @typedef {Number} Int16 */
