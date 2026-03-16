<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

namespace core;

/**
 * Class used to encrypt or decrypt data.
 *
 * This local playground patch restores an OpenSSL fallback because the wasm
 * runtime does not currently ship the sodium extension.
 *
 * @package core
 * @copyright 2020 The Open University
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class encryption {

    /** @var string Encryption method: Sodium */
    const METHOD_SODIUM = 'sodium';

    /** @var string Encryption method: OpenSSL fallback */
    const METHOD_OPENSSL = 'openssl';

    /** @var string OpenSSL cipher used in the wasm fallback */
    const OPENSSL_CIPHER = 'aes-256-cbc';

    /**
     * @deprecated since Moodle 4.3 Sodium is always present
     */
    #[\core\attribute\deprecated(null, reason: 'Sodium is always present', since: '4.3', mdl: 'MDL-71421', final: true)]
    public static function is_sodium_installed() {
        \core\deprecation::emit_deprecation([self::class, __FUNCTION__]);
    }

    /**
     * Gets the encryption method to use
     *
     * @return string Current encryption method
     */
    protected static function get_encryption_method(): string {
        if (defined('SODIUM_CRYPTO_SECRETBOX_NONCEBYTES')
                && function_exists('sodium_crypto_secretbox')
                && function_exists('sodium_crypto_secretbox_open')
                && function_exists('sodium_crypto_secretbox_keygen')) {
            return self::METHOD_SODIUM;
        }

        if (function_exists('openssl_encrypt')
                && function_exists('openssl_decrypt')
                && function_exists('openssl_cipher_iv_length')) {
            return self::METHOD_OPENSSL;
        }

        return self::METHOD_SODIUM;
    }

    /**
     * Creates a key for the server.
     *
     * @param string|null $method Encryption method (only if you want to create a non-default key)
     * @param bool $chmod If true, restricts the file access of the key
     * @throws \moodle_exception If the server already has a key, or there is an error
     */
    public static function create_key(?string $method = null, bool $chmod = true): void {
        if ($method === null) {
            $method = self::get_encryption_method();
        }

        if (self::key_exists($method)) {
            throw new \moodle_exception('encryption_keyalreadyexists', 'error');
        }

        if (defined('BEHAT_SITE_RUNNING') || PHPUNIT_TEST) {
            $chmod = false;
        }

        switch ($method) {
            case self::METHOD_SODIUM:
                $key = sodium_crypto_secretbox_keygen();
                break;
            case self::METHOD_OPENSSL:
                $key = random_bytes(32);
                break;
            default:
                throw new \coding_exception('Unknown method: ' . $method);
        }

        $folder = self::get_key_folder();
        check_dir_exists($folder);
        $keyfile = self::get_key_file($method);
        file_put_contents($keyfile, $key);
        if ($chmod) {
            chmod($keyfile, 0400);
        }
    }

    /**
     * Gets the folder used to store the secret key.
     *
     * @return string Folder path
     */
    protected static function get_key_folder(): string {
        global $CFG;
        return ($CFG->secretdataroot ?? $CFG->dataroot . '/secret') . '/key';
    }

    /**
     * Gets the file path used to store the secret key.
     *
     * @param string|null $method Encryption method
     * @return string Full path to file
     */
    public static function get_key_file(?string $method = null): string {
        if ($method === null) {
            $method = self::get_encryption_method();
        }

        return self::get_key_folder() . '/' . $method . '.key';
    }

    /**
     * Checks if there is a key file.
     *
     * @param string|null $method Encryption method
     * @return bool True if there is a key file
     */
    public static function key_exists(?string $method = null): bool {
        if ($method === null) {
            $method = self::get_encryption_method();
        }

        return file_exists(self::get_key_file($method));
    }

    /**
     * Gets the current key, automatically creating it if there isn't one yet.
     *
     * @param string|null $method Encryption method
     * @return string The key (binary)
     * @throws \moodle_exception If there isn't one already (and creation is disabled)
     */
    protected static function get_key(?string $method = null): string {
        global $CFG;

        if ($method === null) {
            $method = self::get_encryption_method();
        }

        $keyfile = self::get_key_file($method);
        if (!file_exists($keyfile) && empty($CFG->nokeygeneration)) {
            self::create_key($method);
        }
        $result = @file_get_contents($keyfile);
        if ($result === false) {
            throw new \moodle_exception('encryption_nokey', 'error');
        }
        return $result;
    }

    /**
     * Gets the length in bytes of the initial values data required.
     *
     * @param string $method Crypto method
     * @return int Length in bytes
     */
    protected static function get_iv_length(string $method): int {
        switch ($method) {
            case self::METHOD_SODIUM:
                return SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
            case self::METHOD_OPENSSL:
                $length = openssl_cipher_iv_length(self::OPENSSL_CIPHER);
                if ($length === false || $length <= 0) {
                    throw new \coding_exception('Unknown method: ' . $method);
                }
                return $length;
            default:
                throw new \coding_exception('Unknown method: ' . $method);
        }
    }

    /**
     * Encrypts data using the server's key.
     *
     * @param string $data Data to encrypt, or empty string for no data
     * @param string|null $method Encryption method
     * @return string Encrypted data, or empty string for no data
     * @throws \moodle_exception If encryption fails
     */
    public static function encrypt(string $data, ?string $method = null): string {
        if ($data === '') {
            return '';
        }

        if ($method === null) {
            $method = self::get_encryption_method();
        }

        $iv = random_bytes(self::get_iv_length($method));

        switch($method) {
            case self::METHOD_SODIUM:
                try {
                    $encrypted = sodium_crypto_secretbox($data, $iv, self::get_key($method));
                } catch (\SodiumException $e) {
                    throw new \moodle_exception('encryption_encryptfailed', 'error', '', null, $e->getMessage());
                }
                break;
            case self::METHOD_OPENSSL:
                $encrypted = openssl_encrypt($data, self::OPENSSL_CIPHER, self::get_key($method), OPENSSL_RAW_DATA, $iv);
                if ($encrypted === false) {
                    throw new \moodle_exception('encryption_encryptfailed', 'error');
                }
                break;
            default:
                throw new \coding_exception('Unknown method: ' . $method);
        }

        return $method . ':' . base64_encode($iv . $encrypted);
    }

    /**
     * Decrypts data using the server's key.
     *
     * @param string $data Data to decrypt
     * @return string Decrypted data
     */
    public static function decrypt(string $data): string {
        if ($data === '') {
            return '';
        }

        if (preg_match('~^(' . self::METHOD_SODIUM . '|' . self::METHOD_OPENSSL . '):~', $data, $matches)) {
            $method = $matches[1];
        } else {
            throw new \moodle_exception('encryption_wrongmethod', 'error');
        }

        $realdata = base64_decode(substr($data, strlen($method) + 1), true);
        if ($realdata === false) {
            throw new \moodle_exception('encryption_decryptfailed', 'error', '', null, 'Invalid base64 data');
        }

        $ivlength = self::get_iv_length($method);
        if (strlen($realdata) < $ivlength + 1) {
            throw new \moodle_exception('encryption_decryptfailed', 'error', '', null, 'Insufficient data');
        }

        $iv = substr($realdata, 0, $ivlength);
        $encrypted = substr($realdata, $ivlength);

        switch ($method) {
            case self::METHOD_SODIUM:
                try {
                    $decrypted = sodium_crypto_secretbox_open($encrypted, $iv, self::get_key($method));
                } catch (\SodiumException $e) {
                    throw new \moodle_exception('encryption_decryptfailed', 'error', '', null, $e->getMessage());
                }
                if ($decrypted === false) {
                    throw new \moodle_exception('encryption_decryptfailed', 'error', '', null, 'Integrity check failed');
                }
                break;
            case self::METHOD_OPENSSL:
                $decrypted = openssl_decrypt($encrypted, self::OPENSSL_CIPHER, self::get_key($method), OPENSSL_RAW_DATA, $iv);
                if ($decrypted === false) {
                    throw new \moodle_exception('encryption_decryptfailed', 'error', '', null, 'Integrity check failed');
                }
                break;
            default:
                throw new \coding_exception('Unknown method: ' . $method);
        }

        return $decrypted;
    }
}
