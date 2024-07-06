'use strict';

let sigs = require('./_rpc-signatures.json');

let names = Object.keys(sigs);

function sortNewSigs() {
  names.sort();

  /** @type {Object.<String, String>} */
  let orderedSigs = {};
  for (let name of names) {
    orderedSigs[name] = sigs[name];
  }
  let sigsJson = JSON.stringify(orderedSigs, null, 2);
  console.info(sigsJson);
}

if (false) {
  sortNewSigs();
  return;
}

function generateFunctions() {
  for (let name of names) {
    let typesStr = sigs[name];
    let fnStr = generateFunction(name, typesStr);
    console.info(fnStr);
    console.info();
  }
}

let rpcTypeMap = {
  int: 'Number',
  float: 'Number',
  str: 'String',
  bool: 'Boolean',
  obj: 'Object.<String, any>',
  int_str: 'Number|String',
};

function generateFunction(name, typesStr) {
  let argTypes = typesStr.split(' ');
  if (argTypes[0] === '') {
    argTypes.shift();
  }

  let argStrs = [];
  let docStrs = [];
  docStrs.push(`/**`);
  for (let i = 0; i < argTypes.length; i += 1) {
    let argType = argTypes[i];
    let typeName = rpcTypeMap[argType];
    if (!typeName) {
      console.error(argTypes);
      throw new Error(`unknown type spec '${argType}'`);
    }

    let n = i + 1;
    let argName = `${argType}${n}`;
    // TODO give meaningful names to the RPC call arguments
    argStrs.push(argName);
    docStrs.push(` * @param {${typeName}} ${argName}`);
  }
  argStrs.push('...extras');
  docStrs.push(` * @param {...any} extras`);
  docStrs.push(` */`);

  let argsStr = argStrs.join(', ');
  let fnStrs = [
    `rpc.${name} = async function (${argsStr}) {`,
    `  return await rpc._wrapRequest('${name}', '${typesStr}', ${argsStr});`,
    `};`,
  ];
  let lname = name.toLowerCase();
  if (lname !== name) {
    fnStrs.push(`rpc.${lname} = rpc.${name};`);
  }

  fnStrs = docStrs.concat(fnStrs);
  let fnStr = fnStrs.join('\n');
  return fnStr;
}

generateFunctions();
