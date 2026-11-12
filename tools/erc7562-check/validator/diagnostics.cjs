// Only diagnostic dependency replaced: function identity needed by OP-052/053/054.
exports.dumpCallTree = () => {};
exports._tryDetectKnownMethod = c => c.input === '0x' ? '0x' : (c.input || '').slice(0,10) === '0xb760faf9' ? 'depositTo' : (c.input || '').slice(0,10);
