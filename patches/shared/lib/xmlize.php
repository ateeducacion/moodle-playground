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

/**
 * Code for parsing xml files.
 *
 * Handles functionality for:
 *
 * Import of xml files in questionbank and course import.
 * Can handle xml files larger than 10MB through chunking the input file.
 * Replaces the original xmlize by Hans Anderson, {@link http://www.hansanderson.com/contact/}
 * with equal interface.
 *
 * This local patch keeps the same parser semantics but avoids object-method
 * callbacks in xml_set_*_handler(), which are not reliable in the current
 * php-wasm XML extension build.
 *
 * @package    core
 * @subpackage lib
 * @copyright  Kilian Singer
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

/**
 * Exception thrown when there is an error parsing an XML file.
 *
 * @copyright 2010 The Open University
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class xml_format_exception extends moodle_exception {
    /** @var string */
    public $errorstring;
    /** @var string */
    public $char;

    /**
     * Constructor function
     *
     * @param string $errorstring Errorstring
     * @param int $line Linenumber
     * @param string $char Errorcharacter
     * @param string $link Link
     */
    public function __construct($errorstring, $line, $char, $link = '') {
        $this->errorstring = $errorstring;
        $this->line = $line;
        $this->char = $char;

        $a = new stdClass();
        $a->errorstring = $errorstring;
        $a->errorline = $line;
        $a->errorchar = $char;
        parent::__construct('errorparsingxml', 'error', $link, $a);
    }
}

/**
 * Class for parsing xml files.
 *
 * Handles functionality for:
 *
 * Import of xml files in questionbank and course import.
 * Can handle xml files larger than 10MB through chunking the input file.
 * Uses a similar interface to the original version xmlize() by Hans Anderson.
 *
 * @package    core
 * @subpackage lib
 * @copyright  Kilian Singer
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class core_xml_parser {
    /** @var array resulting $xml tree */
    private $xml;
    /** @var array stores references to constructed $xml tree */
    private $current;
    /** @var int stores the level in the XML tree */
    private $level;
    /** @var array parser-id => parser instance */
    private static $handlerregistry = [];

    /**
     * Build a stable registry key for the XML parser callback parameter.
     *
     * @param mixed $parser XML parser handle passed by ext/xml.
     * @return string
     */
    private static function get_parser_key($parser): string {
        if (is_object($parser)) {
            return 'obj:' . spl_object_id($parser);
        }
        return 'scalar:' . (string)$parser;
    }

    /**
     * Register the current parser instance for callback dispatch.
     *
     * @param mixed $parser XML parser handle returned by xml_parser_create().
     * @return void
     */
    public static function register_parser($parser): void {
        self::$handlerregistry[self::get_parser_key($parser)] = $parser instanceof self
            ? $parser
            : end(self::$handlerregistry);
    }

    /**
     * Bind an XML parser handle to this parser instance.
     *
     * @param mixed $parser XML parser handle returned by xml_parser_create().
     * @return void
     */
    public function bind_parser($parser): void {
        self::$handlerregistry[self::get_parser_key($parser)] = $this;
    }

    /**
     * Remove a parser binding after parsing completes.
     *
     * @param mixed $parser XML parser handle returned by xml_parser_create().
     * @return void
     */
    public static function unregister_parser($parser): void {
        unset(self::$handlerregistry[self::get_parser_key($parser)]);
    }

    /**
     * Resolve the parser instance bound to the callback parser handle.
     *
     * @param mixed $parser XML parser handle passed by ext/xml.
     * @return self|null
     */
    public static function get_bound_parser($parser): ?self {
        $key = self::get_parser_key($parser);
        return self::$handlerregistry[$key] ?? null;
    }

    /**
     * Is called when tags are opened.
     *
     * @param mixed $parser The XML parser handle.
     * @param string $name The XML tag name.
     * @param array $attrs Stores attributes of XML tag.
     * @return void
     */
    public function handle_startelement($parser, $name, $attrs): void {
        $current = &$this->current;
        $level = &$this->level;
        if (!empty($name)) {
            if ($level == 0) {
                $current[$level][$name] = array();
                $current[$level][$name]['@'] = $attrs;
                $current[$level][$name]['#'] = array();
                $current[$level + 1] = &$current[$level][$name]['#'];
                $level++;
            } else {
                if (empty($current[$level][$name])) {
                    $current[$level][$name] = array();
                }
                $siz = count($current[$level][$name]);
                if (!empty($attrs)) {
                    $current[$level][$name][$siz]['@'] = $attrs;
                }
                $current[$level][$name][$siz]['#'] = array();
                $current[$level + 1] = &$current[$level][$name][$siz]['#'];
                $level++;
            }
        }
    }

    /**
     * Is called when tags are closed.
     *
     * @param mixed $parser The XML parser handle.
     * @param string $name The XML tag name.
     * @return void
     */
    public function handle_endelement($parser, $name): void {
        $current = &$this->current;
        $level = &$this->level;
        if (!empty($name)) {
            if (empty($current[$level])) {
                $current[$level] = '';
            } else if (array_key_exists(0, $current[$level])) {
                if (count($current[$level]) == 1) {
                    $current[$level] = $current[$level][0];
                }
            }
            $level--;
        }
    }

    /**
     * Is called for text between the start and the end of tags.
     *
     * @param mixed $parser The XML parser handle.
     * @param string $data The XML character data.
     * @return void
     */
    public function handle_characterdata($parser, $data): void {
        $current = &$this->current;
        $level = &$this->level;
        if (($data == '0') || (!empty($data) && trim($data) != '')) {
            $siz = count($current[$level]);
            if ($siz == 0) {
                $current[$level][0] = $data;
            } else {
                $key = max(array_keys($current[$level]));
                if (is_int($key)) {
                    end($current[$level]);
                    if (is_int(key($current[$level]))) {
                        $current[$level][$key] = $current[$level][$key] . $data;
                    } else {
                        $current[$level][$key + 1] = $data;
                    }
                } else {
                    $current[$level][0] = $data;
                }
            }
        }
    }

    /**
     * Parses XML string.
     *
     * @param string $data the XML source to parse.
     * @param int $whitespace If set to 1 allows the parser to skip "space" characters in xml document. Default is 1
     * @param string $encoding Specify an OUTPUT encoding. If not specified, it defaults to UTF-8.
     * @param bool $reporterrors if set to true, then a {@link xml_format_exception}
     *      exception will be thrown if the XML is not well-formed. Otherwise errors are ignored.
     * @return array|false representation of the parsed XML.
     */
    public function parse($data, $whitespace = 1, $encoding = 'UTF-8', $reporterrors = false) {
        $data = trim($data);
        $this->xml = array();
        $this->current = array();
        $this->level = 0;
        $this->current[0] = &$this->xml;
        $parser = xml_parser_create($encoding);
        $this->bind_parser($parser);
        xml_parser_set_option($parser, XML_OPTION_CASE_FOLDING, 0);
        xml_parser_set_option($parser, XML_OPTION_SKIP_WHITE, $whitespace);
        xml_set_element_handler($parser, 'moodle_playground_xmlize_startelement', 'moodle_playground_xmlize_endelement');
        xml_set_character_data_handler($parser, 'moodle_playground_xmlize_characterdata');

        for ($i = 0; $i < strlen($data); $i += 4096) {
            if (!xml_parse($parser, substr($data, $i, 4096))) {
                break;
            }
        }

        if ($reporterrors) {
            $errorcode = xml_get_error_code($parser);
            if ($errorcode) {
                $exception = new xml_format_exception(
                    xml_error_string($errorcode),
                    xml_get_current_line_number($parser),
                    xml_get_current_column_number($parser)
                );
                self::unregister_parser($parser);
                xml_parser_free($parser);
                throw $exception;
            }
        }

        self::unregister_parser($parser);
        xml_parser_free($parser);
        if (empty($this->xml)) {
            return false;
        }
        return $this->xml;
    }
}

/**
 * Dispatch start-element callbacks through a global function name.
 *
 * @param mixed $parser The XML parser handle.
 * @param string $name The XML tag name.
 * @param array $attrs The XML attributes.
 * @return void
 */
function moodle_playground_xmlize_startelement($parser, $name, $attrs): void {
    $instance = core_xml_parser::get_bound_parser($parser);
    if ($instance) {
        $instance->handle_startelement($parser, $name, $attrs);
    }
}

/**
 * Dispatch end-element callbacks through a global function name.
 *
 * @param mixed $parser The XML parser handle.
 * @param string $name The XML tag name.
 * @return void
 */
function moodle_playground_xmlize_endelement($parser, $name): void {
    $instance = core_xml_parser::get_bound_parser($parser);
    if ($instance) {
        $instance->handle_endelement($parser, $name);
    }
}

/**
 * Dispatch character-data callbacks through a global function name.
 *
 * @param mixed $parser The XML parser handle.
 * @param string $data The XML character data.
 * @return void
 */
function moodle_playground_xmlize_characterdata($parser, $data): void {
    $instance = core_xml_parser::get_bound_parser($parser);
    if ($instance) {
        $instance->handle_characterdata($parser, $data);
    }
}

/**
 * XML parsing function calles into class.
 *
 * @param string $data the XML source to parse.
 * @param int $whitespace If set to 1 allows the parser to skip "space" characters in xml document. Default is 1
 * @param string $encoding Specify an OUTPUT encoding. If not specified, it defaults to UTF-8.
 * @param bool $reporterrors if set to true, then a {@link xml_format_exception}
 *      exception will be thrown if the XML is not well-formed. Otherwise errors are ignored.
 * @return array representation of the parsed XML.
 */
function xmlize($data, $whitespace = 1, $encoding = 'UTF-8', $reporterrors = false) {
    $hxml = new core_xml_parser();
    return $hxml->parse($data, $whitespace, $encoding, $reporterrors);
}
