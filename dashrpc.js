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
        //@ts-ignore - TODO map optional params
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
        request = Object.assign(
          {
            id: getRandomId(),
          },
          request,
        );
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
    // https://github.com/dashpay/docs-core/blob/main/docs/api/remote-procedure-call-quick-reference.md
    // https://github.com/dashpay/dash/tree/master/src
    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.abandonTransaction = async function (str1, ...extras) {
      return await rpc._wrapRequest('abandonTransaction', 'str', str1, ...extras);
    };
    rpc.abandontransaction = rpc.abandonTransaction;

    /**
     * @param {Number} int1
     * @param {String} str2
     * @param {String} str3
     * @param {...any} extras
     */
    rpc.addMultiSigAddress = async function (int1, str2, str3, ...extras) {
      return await rpc._wrapRequest('addMultiSigAddress', 'int str str', int1, str2, str3, ...extras);
    };
    rpc.addmultisigaddress = rpc.addMultiSigAddress;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.addNode = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('addNode', 'str str', str1, str2, ...extras);
    };
    rpc.addnode = rpc.addNode;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.backupWallet = async function (str1, ...extras) {
      return await rpc._wrapRequest('backupWallet', 'str', str1, ...extras);
    };
    rpc.backupwallet = rpc.backupWallet;

    /**
     * @param {...any} extras
     */
    rpc.clearBanned = async function (...extras) {
      return await rpc._wrapRequest('clearBanned', '', ...extras);
    };
    rpc.clearbanned = rpc.clearBanned;

    /**
     * @param {Number} int1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.createMultiSig = async function (int1, str2, ...extras) {
      return await rpc._wrapRequest('createMultiSig', 'int str', int1, str2, ...extras);
    };
    rpc.createmultisig = rpc.createMultiSig;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Number} int3
     * @param {...any} extras
     */
    rpc.createRawTransaction = async function (str1, str2, int3, ...extras) {
      return await rpc._wrapRequest('createRawTransaction', 'str str int', str1, str2, int3, ...extras);
    };
    rpc.createrawtransaction = rpc.createRawTransaction;

    /**
     * @param {String} str1
     * @param {Boolean} bool2
     * @param {Boolean} bool3
     * @param {String} str4
     * @param {Boolean} bool5
     * @param {Boolean} bool6
     * @param {...any} extras
     */
    rpc.createWallet = async function (str1, bool2, bool3, str4, bool5, bool6, ...extras) {
      return await rpc._wrapRequest(
        'createWallet',
        'str bool bool str bool bool',
        str1,
        bool2,
        bool3,
        str4,
        bool5,
        bool6,
        ...extras,
      );
    };
    rpc.createwallet = rpc.createWallet;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.debug = async function (str1, ...extras) {
      return await rpc._wrapRequest('debug', 'str', str1, ...extras);
    };

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.decodeRawTransaction = async function (str1, ...extras) {
      return await rpc._wrapRequest('decodeRawTransaction', 'str', str1, ...extras);
    };
    rpc.decoderawtransaction = rpc.decodeRawTransaction;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.decodeScript = async function (str1, ...extras) {
      return await rpc._wrapRequest('decodeScript', 'str', str1, ...extras);
    };
    rpc.decodescript = rpc.decodeScript;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.disconnectNode = async function (str1, ...extras) {
      return await rpc._wrapRequest('disconnectNode', 'str', str1, ...extras);
    };
    rpc.disconnectnode = rpc.disconnectNode;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.dumpPrivKey = async function (str1, ...extras) {
      return await rpc._wrapRequest('dumpPrivKey', 'str', str1, ...extras);
    };
    rpc.dumpprivkey = rpc.dumpPrivKey;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.dumpWallet = async function (str1, ...extras) {
      return await rpc._wrapRequest('dumpWallet', 'str', str1, ...extras);
    };
    rpc.dumpwallet = rpc.dumpWallet;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.encryptWallet = async function (str1, ...extras) {
      return await rpc._wrapRequest('encryptWallet', 'str', str1, ...extras);
    };
    rpc.encryptwallet = rpc.encryptWallet;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.estimateFee = async function (int1, ...extras) {
      return await rpc._wrapRequest('estimateFee', 'int', int1, ...extras);
    };
    rpc.estimatefee = rpc.estimateFee;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.estimatePriority = async function (int1, ...extras) {
      return await rpc._wrapRequest('estimatePriority', 'int', int1, ...extras);
    };
    rpc.estimatepriority = rpc.estimatePriority;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.estimateSmartFee = async function (int1, ...extras) {
      return await rpc._wrapRequest('estimateSmartFee', 'int', int1, ...extras);
    };
    rpc.estimatesmartfee = rpc.estimateSmartFee;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.estimateSmartPriority = async function (int1, ...extras) {
      return await rpc._wrapRequest('estimateSmartPriority', 'int', int1, ...extras);
    };
    rpc.estimatesmartpriority = rpc.estimateSmartPriority;

    /**
     * @param {String} str1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.fundRawTransaction = async function (str1, bool2, ...extras) {
      return await rpc._wrapRequest('fundRawTransaction', 'str bool', str1, bool2, ...extras);
    };
    rpc.fundrawtransaction = rpc.fundRawTransaction;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.generate = async function (int1, ...extras) {
      return await rpc._wrapRequest('generate', 'int', int1, ...extras);
    };

    /**
     * @param {Number} int1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.generateToAddress = async function (int1, str2, ...extras) {
      return await rpc._wrapRequest('generateToAddress', 'int str', int1, str2, ...extras);
    };
    rpc.generatetoaddress = rpc.generateToAddress;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.getAccount = async function (str1, ...extras) {
      return await rpc._wrapRequest('getAccount', 'str', str1, ...extras);
    };
    rpc.getaccount = rpc.getAccount;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.getAccountAddress = async function (str1, ...extras) {
      return await rpc._wrapRequest('getAccountAddress', 'str', str1, ...extras);
    };
    rpc.getaccountaddress = rpc.getAccountAddress;

    /**
     * @param {Boolean} bool1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.getAddedNodeInfo = async function (bool1, str2, ...extras) {
      return await rpc._wrapRequest('getAddedNodeInfo', 'bool str', bool1, str2, ...extras);
    };
    rpc.getaddednodeinfo = rpc.getAddedNodeInfo;

    /**
     * @param {Object.<String, any>} obj1
     * @param {...any} extras
     */
    rpc.getAddressBalance = async function (obj1, ...extras) {
      return await rpc._wrapRequest('getAddressBalance', 'obj', obj1, ...extras);
    };
    rpc.getaddressbalance = rpc.getAddressBalance;

    /**
     * @param {Object.<String, any>} obj1
     * @param {...any} extras
     */
    rpc.getAddressDeltas = async function (obj1, ...extras) {
      return await rpc._wrapRequest('getAddressDeltas', 'obj', obj1, ...extras);
    };
    rpc.getaddressdeltas = rpc.getAddressDeltas;

    /**
     * @param {Object.<String, any>} obj1
     * @param {...any} extras
     */
    rpc.getAddressMempool = async function (obj1, ...extras) {
      return await rpc._wrapRequest('getAddressMempool', 'obj', obj1, ...extras);
    };
    rpc.getaddressmempool = rpc.getAddressMempool;

    /**
     * @param {Object.<String, any>} obj1
     * @param {...any} extras
     */
    rpc.getAddressTxids = async function (obj1, ...extras) {
      return await rpc._wrapRequest('getAddressTxids', 'obj', obj1, ...extras);
    };
    rpc.getaddresstxids = rpc.getAddressTxids;

    /**
     * @param {Object.<String, any>} obj1
     * @param {...any} extras
     */
    rpc.getAddressUtxos = async function (obj1, ...extras) {
      return await rpc._wrapRequest('getAddressUtxos', 'obj', obj1, ...extras);
    };
    rpc.getaddressutxos = rpc.getAddressUtxos;

    /**
     * @param {...any} extras
     */
    rpc.getAddressesByAccount = async function (...extras) {
      return await rpc._wrapRequest('getAddressesByAccount', '', ...extras);
    };
    rpc.getaddressesbyaccount = rpc.getAddressesByAccount;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.getBalance = async function (str1, int2, bool3, ...extras) {
      return await rpc._wrapRequest('getBalance', 'str int bool', str1, int2, bool3, ...extras);
    };
    rpc.getbalance = rpc.getBalance;

    /**
     * @param {...any} extras
     */
    rpc.getBestBlockHash = async function (...extras) {
      return await rpc._wrapRequest('getBestBlockHash', '', ...extras);
    };
    rpc.getbestblockhash = rpc.getBestBlockHash;

    /**
     * @param {...any} extras
     */
    rpc.getBestChainLock = async function (...extras) {
      return await rpc._wrapRequest('getBestChainLock', '', ...extras);
    };
    rpc.getbestchainlock = rpc.getBestChainLock;

    /**
     * @param {String} str1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.getBlock = async function (str1, bool2, ...extras) {
      return await rpc._wrapRequest('getBlock', 'str bool', str1, bool2, ...extras);
    };
    rpc.getblock = rpc.getBlock;

    /**
     * @param {...any} extras
     */
    rpc.getBlockCount = async function (...extras) {
      return await rpc._wrapRequest('getBlockCount', '', ...extras);
    };
    rpc.getblockcount = rpc.getBlockCount;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.getBlockHash = async function (int1, ...extras) {
      return await rpc._wrapRequest('getBlockHash', 'int', int1, ...extras);
    };
    rpc.getblockhash = rpc.getBlockHash;

    /**
     * @param {Number} int1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.getBlockHashes = async function (int1, int2, ...extras) {
      return await rpc._wrapRequest('getBlockHashes', 'int int', int1, int2, ...extras);
    };
    rpc.getblockhashes = rpc.getBlockHashes;

    /**
     * @param {String} str1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.getBlockHeader = async function (str1, bool2, ...extras) {
      return await rpc._wrapRequest('getBlockHeader', 'str bool', str1, bool2, ...extras);
    };
    rpc.getblockheader = rpc.getBlockHeader;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.getBlockHeaders = async function (str1, int2, bool3, ...extras) {
      return await rpc._wrapRequest('getBlockHeaders', 'str int bool', str1, int2, bool3, ...extras);
    };
    rpc.getblockheaders = rpc.getBlockHeaders;

    /**
     * @param {Number|String} int_str1
     * @param {Object.<String, any>} obj2
     * @param {...any} extras
     */
    rpc.getBlockStats = async function (int_str1, obj2, ...extras) {
      return await rpc._wrapRequest('getBlockStats', 'int_str obj', int_str1, obj2, ...extras);
    };
    rpc.getblockstats = rpc.getBlockStats;

    /**
     * @param {...any} extras
     */
    rpc.getBlockTemplate = async function (...extras) {
      return await rpc._wrapRequest('getBlockTemplate', '', ...extras);
    };
    rpc.getblocktemplate = rpc.getBlockTemplate;

    /**
     * @param {...any} extras
     */
    rpc.getBlockchainInfo = async function (...extras) {
      return await rpc._wrapRequest('getBlockchainInfo', '', ...extras);
    };
    rpc.getblockchaininfo = rpc.getBlockchainInfo;

    /**
     * @param {Number} int1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.getChainTips = async function (int1, int2, ...extras) {
      return await rpc._wrapRequest('getChainTips', 'int int', int1, int2, ...extras);
    };
    rpc.getchaintips = rpc.getChainTips;

    /**
     * @param {...any} extras
     */
    rpc.getConnectionCount = async function (...extras) {
      return await rpc._wrapRequest('getConnectionCount', '', ...extras);
    };
    rpc.getconnectioncount = rpc.getConnectionCount;

    /**
     * @param {...any} extras
     */
    rpc.getDifficulty = async function (...extras) {
      return await rpc._wrapRequest('getDifficulty', '', ...extras);
    };
    rpc.getdifficulty = rpc.getDifficulty;

    /**
     * @param {...any} extras
     */
    rpc.getGenerate = async function (...extras) {
      return await rpc._wrapRequest('getGenerate', '', ...extras);
    };
    rpc.getgenerate = rpc.getGenerate;

    /**
     * @param {...any} extras
     */
    rpc.getGovernanceInfo = async function (...extras) {
      return await rpc._wrapRequest('getGovernanceInfo', '', ...extras);
    };
    rpc.getgovernanceinfo = rpc.getGovernanceInfo;

    /**
     * @param {...any} extras
     */
    rpc.getInfo = async function (...extras) {
      return await rpc._wrapRequest('getInfo', '', ...extras);
    };
    rpc.getinfo = rpc.getInfo;

    /**
     * @param {...any} extras
     */
    rpc.getMemPoolInfo = async function (...extras) {
      return await rpc._wrapRequest('getMemPoolInfo', '', ...extras);
    };
    rpc.getmempoolinfo = rpc.getMemPoolInfo;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Number} int3
     * @param {...any} extras
     */
    rpc.getMerkleBlocks = async function (str1, str2, int3, ...extras) {
      return await rpc._wrapRequest('getMerkleBlocks', 'str str int', str1, str2, int3, ...extras);
    };
    rpc.getmerkleblocks = rpc.getMerkleBlocks;

    /**
     * @param {...any} extras
     */
    rpc.getMiningInfo = async function (...extras) {
      return await rpc._wrapRequest('getMiningInfo', '', ...extras);
    };
    rpc.getmininginfo = rpc.getMiningInfo;

    /**
     * @param {...any} extras
     */
    rpc.getNetTotals = async function (...extras) {
      return await rpc._wrapRequest('getNetTotals', '', ...extras);
    };
    rpc.getnettotals = rpc.getNetTotals;

    /**
     * @param {Number} int1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.getNetworkHashps = async function (int1, int2, ...extras) {
      return await rpc._wrapRequest('getNetworkHashps', 'int int', int1, int2, ...extras);
    };
    rpc.getnetworkhashps = rpc.getNetworkHashps;

    /**
     * @param {...any} extras
     */
    rpc.getNetworkInfo = async function (...extras) {
      return await rpc._wrapRequest('getNetworkInfo', '', ...extras);
    };
    rpc.getnetworkinfo = rpc.getNetworkInfo;

    /**
     * @param {...any} extras
     */
    rpc.getNewAddress = async function (...extras) {
      return await rpc._wrapRequest('getNewAddress', '', ...extras);
    };
    rpc.getnewaddress = rpc.getNewAddress;

    /**
     * @param {...any} extras
     */
    rpc.getPeerInfo = async function (...extras) {
      return await rpc._wrapRequest('getPeerInfo', '', ...extras);
    };
    rpc.getpeerinfo = rpc.getPeerInfo;

    /**
     * @param {...any} extras
     */
    rpc.getPoolInfo = async function (...extras) {
      return await rpc._wrapRequest('getPoolInfo', '', ...extras);
    };
    rpc.getpoolinfo = rpc.getPoolInfo;

    /**
     * @param {...any} extras
     */
    rpc.getRawChangeAddress = async function (...extras) {
      return await rpc._wrapRequest('getRawChangeAddress', '', ...extras);
    };
    rpc.getrawchangeaddress = rpc.getRawChangeAddress;

    /**
     * @param {Boolean} bool1
     * @param {...any} extras
     */
    rpc.getRawMemPool = async function (bool1, ...extras) {
      return await rpc._wrapRequest('getRawMemPool', 'bool', bool1, ...extras);
    };
    rpc.getrawmempool = rpc.getRawMemPool;

    /**
     * @param {String} str1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.getRawTransaction = async function (str1, bool2, ...extras) {
      return await rpc._wrapRequest('getRawTransaction', 'str bool', str1, bool2, ...extras);
    };
    rpc.getrawtransaction = rpc.getRawTransaction;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.getReceivedByAccount = async function (str1, int2, ...extras) {
      return await rpc._wrapRequest('getReceivedByAccount', 'str int', str1, int2, ...extras);
    };
    rpc.getreceivedbyaccount = rpc.getReceivedByAccount;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.getReceivedByAddress = async function (str1, int2, ...extras) {
      return await rpc._wrapRequest('getReceivedByAddress', 'str int', str1, int2, ...extras);
    };
    rpc.getreceivedbyaddress = rpc.getReceivedByAddress;

    /**
     * @param {Object.<String, any>} obj1
     * @param {...any} extras
     */
    rpc.getSpentInfo = async function (obj1, ...extras) {
      return await rpc._wrapRequest('getSpentInfo', 'obj', obj1, ...extras);
    };
    rpc.getspentinfo = rpc.getSpentInfo;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.getSuperBlockBudget = async function (int1, ...extras) {
      return await rpc._wrapRequest('getSuperBlockBudget', 'int', int1, ...extras);
    };
    rpc.getsuperblockbudget = rpc.getSuperBlockBudget;

    /**
     * @param {...any} extras
     */
    rpc.getTransaction = async function (...extras) {
      return await rpc._wrapRequest('getTransaction', '', ...extras);
    };
    rpc.gettransaction = rpc.getTransaction;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.getTxOut = async function (str1, int2, bool3, ...extras) {
      return await rpc._wrapRequest('getTxOut', 'str int bool', str1, int2, bool3, ...extras);
    };
    rpc.gettxout = rpc.getTxOut;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.getTxOutProof = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('getTxOutProof', 'str str', str1, str2, ...extras);
    };
    rpc.gettxoutproof = rpc.getTxOutProof;

    /**
     * @param {...any} extras
     */
    rpc.getTxOutSetInfo = async function (...extras) {
      return await rpc._wrapRequest('getTxOutSetInfo', '', ...extras);
    };
    rpc.gettxoutsetinfo = rpc.getTxOutSetInfo;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.getUser = async function (str1, ...extras) {
      return await rpc._wrapRequest('getUser', 'str', str1, ...extras);
    };
    rpc.getuser = rpc.getUser;

    /**
     * @param {...any} extras
     */
    rpc.getWalletInfo = async function (...extras) {
      return await rpc._wrapRequest('getWalletInfo', '', ...extras);
    };
    rpc.getwalletinfo = rpc.getWalletInfo;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.gobject = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('gobject', 'str str', str1, str2, ...extras);
    };

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.help = async function (str1, ...extras) {
      return await rpc._wrapRequest('help', 'str', str1, ...extras);
    };

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.importAddress = async function (str1, str2, bool3, ...extras) {
      return await rpc._wrapRequest('importAddress', 'str str bool', str1, str2, bool3, ...extras);
    };
    rpc.importaddress = rpc.importAddress;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.importElectrumWallet = async function (str1, int2, ...extras) {
      return await rpc._wrapRequest('importElectrumWallet', 'str int', str1, int2, ...extras);
    };
    rpc.importelectrumwallet = rpc.importElectrumWallet;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.importPrivKey = async function (str1, str2, bool3, ...extras) {
      return await rpc._wrapRequest('importPrivKey', 'str str bool', str1, str2, bool3, ...extras);
    };
    rpc.importprivkey = rpc.importPrivKey;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.importPubKey = async function (str1, str2, bool3, ...extras) {
      return await rpc._wrapRequest('importPubKey', 'str str bool', str1, str2, bool3, ...extras);
    };
    rpc.importpubkey = rpc.importPubKey;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.importWallet = async function (str1, ...extras) {
      return await rpc._wrapRequest('importWallet', 'str', str1, ...extras);
    };
    rpc.importwallet = rpc.importWallet;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {String} str3
     * @param {String} str4
     * @param {Boolean} bool5
     * @param {...any} extras
     */
    rpc.instantSendToAddress = async function (str1, int2, str3, str4, bool5, ...extras) {
      return await rpc._wrapRequest(
        'instantSendToAddress',
        'str int str str bool',
        str1,
        int2,
        str3,
        str4,
        bool5,
        ...extras,
      );
    };
    rpc.instantsendtoaddress = rpc.instantSendToAddress;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.invalidateBlock = async function (str1, ...extras) {
      return await rpc._wrapRequest('invalidateBlock', 'str', str1, ...extras);
    };
    rpc.invalidateblock = rpc.invalidateBlock;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.keyPoolRefill = async function (int1, ...extras) {
      return await rpc._wrapRequest('keyPoolRefill', 'int', int1, ...extras);
    };
    rpc.keypoolrefill = rpc.keyPoolRefill;

    /**
     * @param {Number} int1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.listAccounts = async function (int1, bool2, ...extras) {
      return await rpc._wrapRequest('listAccounts', 'int bool', int1, bool2, ...extras);
    };
    rpc.listaccounts = rpc.listAccounts;

    /**
     * @param {...any} extras
     */
    rpc.listAddressGroupings = async function (...extras) {
      return await rpc._wrapRequest('listAddressGroupings', '', ...extras);
    };
    rpc.listaddressgroupings = rpc.listAddressGroupings;

    /**
     * @param {...any} extras
     */
    rpc.listBanned = async function (...extras) {
      return await rpc._wrapRequest('listBanned', '', ...extras);
    };
    rpc.listbanned = rpc.listBanned;

    /**
     * @param {Boolean} bool1
     * @param {...any} extras
     */
    rpc.listLockUnspent = async function (bool1, ...extras) {
      return await rpc._wrapRequest('listLockUnspent', 'bool', bool1, ...extras);
    };
    rpc.listlockunspent = rpc.listLockUnspent;

    /**
     * @param {Number} int1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.listReceivedByAccount = async function (int1, bool2, ...extras) {
      return await rpc._wrapRequest('listReceivedByAccount', 'int bool', int1, bool2, ...extras);
    };
    rpc.listreceivedbyaccount = rpc.listReceivedByAccount;

    /**
     * @param {Number} int1
     * @param {Boolean} bool2
     * @param {...any} extras
     */
    rpc.listReceivedByAddress = async function (int1, bool2, ...extras) {
      return await rpc._wrapRequest('listReceivedByAddress', 'int bool', int1, bool2, ...extras);
    };
    rpc.listreceivedbyaddress = rpc.listReceivedByAddress;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.listSinceBlock = async function (str1, int2, ...extras) {
      return await rpc._wrapRequest('listSinceBlock', 'str int', str1, int2, ...extras);
    };
    rpc.listsinceblock = rpc.listSinceBlock;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {Number} int3
     * @param {Boolean} bool4
     * @param {...any} extras
     */
    rpc.listTransactions = async function (str1, int2, int3, bool4, ...extras) {
      return await rpc._wrapRequest('listTransactions', 'str int int bool', str1, int2, int3, bool4, ...extras);
    };
    rpc.listtransactions = rpc.listTransactions;

    /**
     * @param {Number} int1
     * @param {Number} int2
     * @param {String} str3
     * @param {...any} extras
     */
    rpc.listUnspent = async function (int1, int2, str3, ...extras) {
      return await rpc._wrapRequest('listUnspent', 'int int str', int1, int2, str3, ...extras);
    };
    rpc.listunspent = rpc.listUnspent;

    /**
     * @param {Boolean} bool1
     * @param {Object.<String, any>} obj2
     * @param {...any} extras
     */
    rpc.lockUnspent = async function (bool1, obj2, ...extras) {
      return await rpc._wrapRequest('lockUnspent', 'bool obj', bool1, obj2, ...extras);
    };
    rpc.lockunspent = rpc.lockUnspent;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.masternode = async function (str1, ...extras) {
      return await rpc._wrapRequest('masternode', 'str', str1, ...extras);
    };

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.masternodeBroadcast = async function (str1, ...extras) {
      return await rpc._wrapRequest('masternodeBroadcast', 'str', str1, ...extras);
    };
    rpc.masternodebroadcast = rpc.masternodeBroadcast;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.masternodelist = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('masternodelist', 'str str', str1, str2, ...extras);
    };

    /**
     * @param {...any} extras
     */
    rpc.mnsync = async function (...extras) {
      return await rpc._wrapRequest('mnsync', '', ...extras);
    };

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Number} float3
     * @param {Number} int4
     * @param {String} str5
     * @param {...any} extras
     */
    rpc.move = async function (str1, str2, float3, int4, str5, ...extras) {
      return await rpc._wrapRequest('move', 'str str float int str', str1, str2, float3, int4, str5, ...extras);
    };

    /**
     * @param {...any} extras
     */
    rpc.ping = async function (...extras) {
      return await rpc._wrapRequest('ping', '', ...extras);
    };

    /**
     * @param {String} str1
     * @param {Number} float2
     * @param {Number} int3
     * @param {...any} extras
     */
    rpc.prioritiseTransaction = async function (str1, float2, int3, ...extras) {
      return await rpc._wrapRequest('prioritiseTransaction', 'str float int', str1, float2, int3, ...extras);
    };
    rpc.prioritisetransaction = rpc.prioritiseTransaction;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.privateSend = async function (str1, ...extras) {
      return await rpc._wrapRequest('privateSend', 'str', str1, ...extras);
    };
    rpc.privatesend = rpc.privateSend;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {String} str3
     * @param {...any} extras
     */
    rpc.protx = async function (str1, str2, str3, ...extras) {
      return await rpc._wrapRequest('protx', 'str str str', str1, str2, str3, ...extras);
    };

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {String} str3
     * @param {String} str4
     * @param {String} str5
     * @param {String} str6
     * @param {Number} int7
     * @param {...any} extras
     */
    rpc.quorum = async function (str1, int2, str3, str4, str5, str6, int7, ...extras) {
      return await rpc._wrapRequest(
        'quorum',
        'str int str str str str int',
        str1,
        int2,
        str3,
        str4,
        str5,
        str6,
        int7,
        ...extras,
      );
    };

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.reconsiderBlock = async function (str1, ...extras) {
      return await rpc._wrapRequest('reconsiderBlock', 'str', str1, ...extras);
    };
    rpc.reconsiderblock = rpc.reconsiderBlock;

    /**
     * @param {...any} extras
     */
    rpc.resendWalletTransactions = async function (...extras) {
      return await rpc._wrapRequest('resendWalletTransactions', '', ...extras);
    };
    rpc.resendwallettransactions = rpc.resendWalletTransactions;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Number} float3
     * @param {Number} int4
     * @param {String} str5
     * @param {String} str6
     * @param {...any} extras
     */
    rpc.sendFrom = async function (str1, str2, float3, int4, str5, str6, ...extras) {
      return await rpc._wrapRequest(
        'sendFrom',
        'str str float int str str',
        str1,
        str2,
        float3,
        int4,
        str5,
        str6,
        ...extras,
      );
    };
    rpc.sendfrom = rpc.sendFrom;

    /**
     * @param {String} str1
     * @param {Object.<String, any>} obj2
     * @param {Number} int3
     * @param {String} str4
     * @param {String} str5
     * @param {Boolean} bool6
     * @param {Boolean} bool7
     * @param {...any} extras
     */
    rpc.sendMany = async function (str1, obj2, int3, str4, str5, bool6, bool7, ...extras) {
      return await rpc._wrapRequest(
        'sendMany',
        'str obj int str str bool bool',
        str1,
        obj2,
        int3,
        str4,
        str5,
        bool6,
        bool7,
        ...extras,
      );
    };
    rpc.sendmany = rpc.sendMany;

    /**
     * @param {String} str1
     * @param {Number} float2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.sendRawTransaction = async function (str1, float2, bool3, ...extras) {
      return await rpc._wrapRequest('sendRawTransaction', 'str float bool', str1, float2, bool3, ...extras);
    };
    rpc.sendrawtransaction = rpc.sendRawTransaction;

    /**
     * @param {String} str1
     * @param {Number} float2
     * @param {String} str3
     * @param {String} str4
     * @param {...any} extras
     */
    rpc.sendToAddress = async function (str1, float2, str3, str4, ...extras) {
      return await rpc._wrapRequest('sendToAddress', 'str float str str', str1, float2, str3, str4, ...extras);
    };
    rpc.sendtoaddress = rpc.sendToAddress;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.sentinelPing = async function (str1, ...extras) {
      return await rpc._wrapRequest('sentinelPing', 'str', str1, ...extras);
    };
    rpc.sentinelping = rpc.sentinelPing;

    /**
     * @param {...any} extras
     */
    rpc.setAccount = async function (...extras) {
      return await rpc._wrapRequest('setAccount', '', ...extras);
    };
    rpc.setaccount = rpc.setAccount;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Number} int3
     * @param {Boolean} bool4
     * @param {...any} extras
     */
    rpc.setBan = async function (str1, str2, int3, bool4, ...extras) {
      return await rpc._wrapRequest('setBan', 'str str int bool', str1, str2, int3, bool4, ...extras);
    };
    rpc.setban = rpc.setBan;

    /**
     * @param {Boolean} bool1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.setGenerate = async function (bool1, int2, ...extras) {
      return await rpc._wrapRequest('setGenerate', 'bool int', bool1, int2, ...extras);
    };
    rpc.setgenerate = rpc.setGenerate;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.setMockTime = async function (int1, ...extras) {
      return await rpc._wrapRequest('setMockTime', 'int', int1, ...extras);
    };
    rpc.setmocktime = rpc.setMockTime;

    /**
     * @param {Number} float1
     * @param {...any} extras
     */
    rpc.setTxFee = async function (float1, ...extras) {
      return await rpc._wrapRequest('setTxFee', 'float', float1, ...extras);
    };
    rpc.settxfee = rpc.setTxFee;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.signMessage = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('signMessage', 'str str', str1, str2, ...extras);
    };
    rpc.signmessage = rpc.signMessage;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {String} str3
     * @param {String} str4
     * @param {...any} extras
     */
    rpc.signRawTransaction = async function (str1, str2, str3, str4, ...extras) {
      return await rpc._wrapRequest('signRawTransaction', 'str str str str', str1, str2, str3, str4, ...extras);
    };
    rpc.signrawtransaction = rpc.signRawTransaction;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.spork = async function (str1, ...extras) {
      return await rpc._wrapRequest('spork', 'str', str1, ...extras);
    };

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.sporkupdate = async function (str1, int2, ...extras) {
      return await rpc._wrapRequest('sporkupdate', 'str int', str1, int2, ...extras);
    };

    /**
     * @param {...any} extras
     */
    rpc.stop = async function (...extras) {
      return await rpc._wrapRequest('stop', '', ...extras);
    };

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.submitBlock = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('submitBlock', 'str str', str1, str2, ...extras);
    };
    rpc.submitblock = rpc.submitBlock;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.validateAddress = async function (str1, ...extras) {
      return await rpc._wrapRequest('validateAddress', 'str', str1, ...extras);
    };
    rpc.validateaddress = rpc.validateAddress;

    /**
     * @param {Number} int1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.verifyChain = async function (int1, int2, ...extras) {
      return await rpc._wrapRequest('verifyChain', 'int int', int1, int2, ...extras);
    };
    rpc.verifychain = rpc.verifyChain;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {Number} int3
     * @param {...any} extras
     */
    rpc.verifyChainLock = async function (str1, str2, int3, ...extras) {
      return await rpc._wrapRequest('verifyChainLock', 'str str int', str1, str2, int3, ...extras);
    };
    rpc.verifychainlock = rpc.verifyChainLock;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {String} str3
     * @param {Number} int4
     * @param {...any} extras
     */
    rpc.verifyIsLock = async function (str1, str2, str3, int4, ...extras) {
      return await rpc._wrapRequest('verifyIsLock', 'str str str int', str1, str2, str3, int4, ...extras);
    };
    rpc.verifyislock = rpc.verifyIsLock;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {String} str3
     * @param {...any} extras
     */
    rpc.verifyMessage = async function (str1, str2, str3, ...extras) {
      return await rpc._wrapRequest('verifyMessage', 'str str str', str1, str2, str3, ...extras);
    };
    rpc.verifymessage = rpc.verifyMessage;

    /**
     * @param {String} str1
     * @param {...any} extras
     */
    rpc.verifyTxOutProof = async function (str1, ...extras) {
      return await rpc._wrapRequest('verifyTxOutProof', 'str', str1, ...extras);
    };
    rpc.verifytxoutproof = rpc.verifyTxOutProof;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.voteRaw = async function (str1, int2, ...extras) {
      return await rpc._wrapRequest('voteRaw', 'str int', str1, int2, ...extras);
    };
    rpc.voteraw = rpc.voteRaw;

    /**
     * @param {Number} int1
     * @param {Number} int2
     * @param {...any} extras
     */
    rpc.waitForBlockHeight = async function (int1, int2, ...extras) {
      return await rpc._wrapRequest('waitForBlockHeight', 'int int', int1, int2, ...extras);
    };
    rpc.waitforblockheight = rpc.waitForBlockHeight;

    /**
     * @param {Number} int1
     * @param {...any} extras
     */
    rpc.waitForNewBlock = async function (int1, ...extras) {
      return await rpc._wrapRequest('waitForNewBlock', 'int', int1, ...extras);
    };
    rpc.waitfornewblock = rpc.waitForNewBlock;

    /**
     * @param {...any} extras
     */
    rpc.walletLock = async function (...extras) {
      return await rpc._wrapRequest('walletLock', '', ...extras);
    };
    rpc.walletlock = rpc.walletLock;

    /**
     * @param {String} str1
     * @param {Number} int2
     * @param {Boolean} bool3
     * @param {...any} extras
     */
    rpc.walletPassPhrase = async function (str1, int2, bool3, ...extras) {
      return await rpc._wrapRequest('walletPassPhrase', 'str int bool', str1, int2, bool3, ...extras);
    };
    rpc.walletpassphrase = rpc.walletPassPhrase;

    /**
     * @param {String} str1
     * @param {String} str2
     * @param {...any} extras
     */
    rpc.walletPassphraseChange = async function (str1, str2, ...extras) {
      return await rpc._wrapRequest('walletPassphraseChange', 'str str', str1, str2, ...extras);
    };
    rpc.walletpassphrasechange = rpc.walletPassphraseChange;

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
