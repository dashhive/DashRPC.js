//@ts-ignore
var ENVS = ('object' === typeof module && exports) || {};
(function (window, ENVS) {
  'use strict';

  Object.assign(ENVS, {
    DASHD_RPC_USER: 'abcd1234',
    DASHD_RPC_PASS: '123456789012',
    DASHD_RPC_PASSWORD: '123456789012',
    DASHD_RPC_HOST: 'local.example.com',
    //DASHD_RPC_HOST: '127.0.0.1',
    DASHD_RPC_PORT: 19998,
    DASHD_RPC_TIMEOUT: 10.0,
  });

  // @ts-ignore
  window.ENVS = ENVS;
})(('object' === typeof window && window) || {}, ENVS);
if ('object' === typeof module) {
  module.exports = ENVS;
}
