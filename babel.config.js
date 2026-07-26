module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      [require('babel-preset-expo'), { jsxImportSource: 'nativewind' }],
      require('nativewind/babel'),
    ],
  }
}
