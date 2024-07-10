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
    timeout: 10 * 1000, // bump default from 5s to 10s for up to 10k addresses
    onconnected: async function () {
      console.info(`[info] rpc client connected ${rpcConfig.host}`);
    },
  };
  let rpc = DashRpc.create(rpcConfig);

  if (!process.env.DASHD_RPC_HOST) {
    console.info(`[SKIP] missing 'DASHD_RPC_HOST'`);
    return;
  }

  let height = await rpc.init(rpc);
  console.info(`[info] rpc server is ready. Height = ${height}`);
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
