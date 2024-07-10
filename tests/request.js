'use strict';

let Dotenv = require('dotenv');
Dotenv.config({ path: '.env' });

let DashRpc = require('../');

async function main() {
  let rpcConfig = {
    protocol: 'http', // https for remote, http for local / private networking
    user: process.env.DASHD_RPC_USER,
    pass: process.env.DASHD_RPC_PASS || process.env.DASHD_RPC_PASSWORD,
    host: process.env.DASHD_RPC_HOST || '127.0.0.1',
    port: process.env.DASHD_RPC_PORT || '19898', // mainnet=9998, testnet=19998, regtest=19898
  };
  let rpc = DashRpc.create(rpcConfig);

  if (!process.env.DASHD_RPC_HOST) {
    console.info(`[SKIP] missing 'DASHD_RPC_HOST'`);
    return;
  }

  void (await rpc.init(rpc));

  {
    let decodeTx = await rpc.request('/', {
      method: 'decodeRawTransaction'.toLowerCase(),
      params: [
        '03000000012b35e8bd64852ae0277a7a4ab6d6293f477f27e859251d27a9a3ebcb5855307f000000006b483045022100f88938da326af08203495a94b9a91b4bd11266df096cb67757a17eed1cb761b702205f90d94ead2d68086ba9141959115961cc491d560ce422c1a56a6c165697897e012103755be68d084e7ead4d83e23fb37c3076b16ead432de1b0bdf249290400f263cbffffffff011e140000000000001976a9141e0a6ef6085bb8af443a9e7f8941e61deb09fb5488ac00000000',
      ],
    });

    let txid = '2dd7112a9cbeff5fc56b761bf8b375a37c7f9fe2fc180f41361c62f0e248d4a0';
    if (decodeTx?.result?.txid !== txid) {
      throw new Error(`'decodeRawTransaction' missing 'data.result.txid'`);
    }
    console.info(`PASS: correctly decoded raw transaction`);
  }

  {
    let mnList = await rpc.request('/', {
      method: 'masternodelist'.toLowerCase(),
      params: [],
    });
    if (!mnList?.result) {
      throw new Error(`'masternodelist' missing 'result'`);
    }

    let keys = Object.keys(mnList.result);
    let key = keys[0];
    if (!mnList.result?.[key]?.proTxHash) {
      throw new Error(`'masternodelist' 'result' missing 'proTxHash'`);
    }
    console.info(`PASS: fetched 'masternodelist'`);
  }
}

main()
  .then(function () {
    console.info('Done');
    process.exit(0);
  })
  .catch(function (err) {
    console.error('Fail:');
    console.error(err.stack || err);
    process.exit(1);
  });
