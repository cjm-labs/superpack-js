'use strict';

var tags = require('./type-tags.js');

var F8 = 0xFFFFFFFF;
var F4 = 0xFFFF;
var F2 = 0xFF;

var zeros23 = '00000000000000000000000';
var keysetLUT, keysetList, stringHist, stringPlaceholders;

function byteFromBools(bools, offset) {
  return bools[offset] << 7 |
    bools[offset + 1] << 6 |
    bools[offset + 2] << 5 |
    bools[offset + 3] << 4 |
    bools[offset + 4] << 3 |
    bools[offset + 5] << 2 |
    bools[offset + 6] << 1 |
    bools[offset + 7];
}

function pushUInt32(n, target) {
  target.push(n >>> 24, (n >> 16) & F2, (n >> 8) & F2, n & F2);
}

function pushArrayElements(value, target) {
  value.forEach(function (element) {
    encodeValue(element, target);
  });
}

function encodeString(str, target, lut) {
  var index;
  if (lut && (index = lut.indexOf(str)) !== -1) {
    // Using indexOf knowing lut.length <= 255 so it's O(1)
    // todo: consider better ways to do this
    target.push(tags.STRREF, index);
  } else {
    // Note: this encoding fails if value contains an unmatched surrogate half.
    // utf8Ascii will be an ascii representation of UTF-8 bytes
    // ref: http://monsur.hossa.in/2012/07/20/utf-8-in-javascript.html
    var utf8Bytes = [];
    var utf8Ascii = unescape(encodeURIComponent(str));
    var containsNull = false;
    for (var i = 0; i < utf8Ascii.length; ++i) {
      utf8Bytes.push(utf8Ascii.charCodeAt(i));
      if (utf8Bytes[i] === 0) containsNull = true;
    }

    var numBytes = utf8Bytes.length;
    if (numBytes < 32) {
      target.push(tags.STR5_BASE | numBytes);
    } else if (!containsNull) {
      target.push(tags.CSTRING);
      utf8Bytes.push(0);
    } else if (numBytes <= F2) {
      target.push(tags.STR8, numBytes);
    } else {
      target.push(tags.STR_);
      encodeUInt(numBytes, target);
    }
    // todo: find way around blowing callstack with huge strings
    target.push.apply(target, utf8Bytes);
  }
}

function encodeUInt(value, target) {
  if (value <= 63) {
    target.push(value);
  } else if (value <= 0x3FFF) {
    target.push(tags.UINT14_BASE | (value >> 8), value & F2);
  } else if (value <= F4) {
    target.push(tags.UINT16, value >> 8, value & F2);
  } else if (value <= 0xFFFFFF) {
    target.push(tags.UINT24, value >> 16, (value >> 8) & F2, value & F2);
  } else if (value <= F8) {
    target.push(tags.UINT32);
    pushUInt32(value, target);
  } else {
    target.push(tags.UINT64);
    pushUInt32((value / 0x100000000) & F8, target);
    pushUInt32(value & F8, target);
  }
}

function encodeInteger(value, target) {
  if (value === 0 && 1 / value === -Infinity) {
    target.push(tags.NINT4_BASE);
  } else if (value >= 0) {
    encodeUInt(value, target);
  } else {
    var magnitude = -value;
    if (magnitude <= 15) {
      target.push(tags.NINT4_BASE | magnitude);
    } else if (magnitude <= F2) {
      target.push(tags.NINT8, magnitude);
    } else if (magnitude <= F4) {
      target.push(tags.NINT16, magnitude >> 8, magnitude & F2);
    } else if (magnitude <= F8) {
      target.push(tags.NINT32);
      pushUInt32(magnitude, target);
    } else {
      target.push(tags.NINT64);
      pushUInt32((magnitude / 0x100000000) & F8, target);
      pushUInt32(magnitude & F8, target);
    }
  }
}

function encodeDate(value, target) {
  // timestamp: same as uint48, with unix timestamp in ms
  var timestamp = Date.prototype.getTime.call(value);
  var high = (timestamp / 0x100000000) & F4;
  target.push(tags.TIMESTAMP, high >> 8, high & F2);
  pushUInt32(timestamp & F8, target);
}

function encodeFloat(value, target) {
  // either float32 or double64, need to figure out which.
  var negative = value < 0;

  var exp;
  var bits = (negative ? -value : value).toString(2);
  var firstOne = bits.indexOf(1);
  var lastOne = bits.lastIndexOf(1);
  var dot = bits.indexOf('.');

  if (dot === -1) {
    exp = bits.length - 1;
  } else if (dot < firstOne) {
    exp = dot - firstOne;
  } else {
    exp = dot - 1;
  }
  var mantissa = bits.substring(firstOne + 1, lastOne + 1).replace('.', '');

  if (mantissa.length <= 23 && (-126 <= exp && exp <= 127)) {
    // yay it can fit in a float32
    exp += 127;
    if (negative) exp |= 0x100;
    mantissa = parseInt(mantissa + zeros23.slice(mantissa.length), 2);
    target.push(tags.FLOAT32);
    pushUInt32(mantissa | (exp << 23), target);
  } else {
    // need to use double64
    exp += 1023;
    if (negative) exp |= 0x800;

    mantissa = parseInt(mantissa.length > 52 ?
      mantissa.slice(0, 52) :
      mantissa + (zeros23 + zeros23 + '000000').slice(mantissa.length),
      2
    );

    target.push(tags.DOUBLE64);
    pushUInt32(((mantissa / 0x100000000) & 0xFFFFF) | (exp << 20), target);
    pushUInt32(mantissa & F8, target);
  }
}

function findIndex(keys, table, list) {
  var keyLengths = keys.map(function (key) {
    return key.length;
  }).join(',');
  var keyConcats = keys.join('');
  if (!table[keyLengths]) {
    table[keyLengths] = {};
  }
  if (typeof table[keyLengths][keyConcats] !== 'number') {
    table[keyLengths][keyConcats] = list.length;
    list.push(keys);
  }
  return table[keyLengths][keyConcats];
}

function buildLUT(hist) {
  // Keep the up-to-255 keys that will save the most space, sorted by savings
  return Object.keys(hist).filter(function (key) {
    return hist[key] >= 2 && key.length * hist[key] >= 8;
  }).map(function (key) {
    // [key, expected savings]
    return [key, ((key.length + 1) * hist[key]) - (key.length + 1 + 2 * hist[key])];
  }).sort(function (e1, e2) {
    return e2[1] - e1[1];
  }).slice(0, 255).map(function (elt) {
    return elt[0];
  });
}

function encodeValue(value, target) {
  var i, containsOnlyBooleans;
  if (value === false) {
    target.push(tags.FALSE);
  } else if (value === true) {
    target.push(tags.TRUE);
  } else if (value === null) {
    target.push(tags.NULL);
  } else if (typeof value === 'undefined') {
    target.push(tags.UNDEFINED);
  } else if (typeof value === 'number') {
    if (!isFinite(value)) {
      if (value === Infinity) {
        target.push(tags.FLOAT32, 0x7F, 0x80, 0x00, 0x00);
      } else if (value === -Infinity) {
        target.push(tags.FLOAT32, F2, 0x80, 0x00, 0x00);
      } else if (Number.isNaN(value)) {
        target.push(tags.FLOAT32, 0x7F, 0xC0, 0x00, 0x00);
      }
    } else if (Math.floor(value) === value && value < 0xFFFFFFFFFFFFFFFF) {
      encodeInteger(value, target);
    } else {
      encodeFloat(value, target);
    }
  } else if (typeof value === 'string') {
    // Push the string itself for handling later
    if (stringPlaceholders) {
      stringHist[value] = (stringHist[value] || 0) + 1;
      target.push(value);
    } else {
      encodeString(value, target);
    }
  } else if ({}.toString.call(value) === '[object Date]') {
    encodeDate(value, target);
  } else if (Array.isArray(value)) {
    var numElements = value.length;
    containsOnlyBooleans = true;

    containsOnlyBooleans = value.every(function (element) {
      return typeof element === 'boolean';
    });

    if (containsOnlyBooleans && numElements > 0) {
      if (numElements <= 15) {
        target.push(tags.BARRAY4_BASE | numElements);
      } else if (numElements <= 255) {
        target.push(tags.BARRAY8, numElements);
      } else {
        target.push(tags.BARRAY_);
        encodeUInt(numElements, target);
      }
      for (i = 0; i < numElements; i += 8) {
        // note: there's some out of bounds going on here, but it works out like we want
        target.push(byteFromBools(value, i));
      }
    } else {
      if (numElements <= 31) {
        target.push(tags.ARRAY5_BASE | numElements);
      } else if (numElements <= 255) {
        target.push(tags.ARRAY8, numElements);
      } else {
        target.push(tags.ARRAY_);
        encodeUInt(numElements, target);
      }
      pushArrayElements(value, target);
    }
  } else if (value instanceof ArrayBuffer) {
    target.push(tags.BINARY_);
    encodeValue(value.byteLength, target);
    pushArrayElements(new Uint8Array(value), target);
  } else {
    // assumption: anything not in an earlier case can be treated as an object
    var keys = Object.keys(value).sort();
    var numKeys = keys.length;
    var keysetIndex = findIndex(keys, keysetLUT, keysetList);

    containsOnlyBooleans = keys.every(function (key) {
      return typeof value[key] === 'boolean';
    });

    if (containsOnlyBooleans) {
      target.push(tags.BMAP_);
      encodeUInt(keysetIndex, target);

      var b = [0, 0, 0, 0, 0, 0, 0, 0];
      for (i = 0; i < numKeys; i += 8) {
        for (var j = 0; j < 8; ++j) {
          b[j] = i + j < numKeys && value[keys[i + j]];
        }
        target.push(byteFromBools(b, 0));
      }
    } else {
      target.push(tags.MAP_);
      encodeUInt(keysetIndex, target);

      keys.forEach(function (key) {
        encodeValue(value[key], target);
      });
    }
  }
  return target;
}

module.exports = function encode(value) {
  var output = [];
  keysetLUT = {};
  keysetList = [];
  stringHist = {};
  stringPlaceholders = true;

  var data = encodeValue(value, []);
  var keysetData = encodeValue(keysetList, []);
  var stringLUT = buildLUT(stringHist);

  stringPlaceholders = false;

  if (stringLUT.length > 0 || keysetList.length > 0) {
    output.push(tags.STRLUT);
    output.push(stringLUT.length);
    pushArrayElements(stringLUT, output);
    data = keysetData.concat(data);
  }

  data.forEach(function (piece) {
    if (typeof piece === 'string') {
      encodeString(piece, output, stringLUT);
    } else {
      output.push(piece);
    }
  });

  return output;
};