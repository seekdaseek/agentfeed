const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export default {
  decode(s) {
    const bytes = [0];
    for (const ch of s) {
      let carry = A.indexOf(ch);
      if (carry < 0) throw new Error('bad base58 char ' + ch);
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of s) { if (ch !== '1') break; bytes.push(0); }
    const out = Uint8Array.from(bytes.reverse());
    return out.length >= 64 ? out.slice(0, 64) : Uint8Array.from([...out, ...new Uint8Array(64 - out.length)]);
  },
};
