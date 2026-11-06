((element_comment) @injection.content
  (#set! injection.language "comment"))

((script_block_text) @injection.content
  (#set! injection.language "javascript"))

((script_element_text) @injection.content
  (#set! injection.language "javascript"))

((style_element_text) @injection.content
  (#set! injection.language "css"))

; Keep regex string injection without restoring the full Go overlay stack.
(call_expression
  (selector_expression) @_function
  (#any-of? @_function
    "regexp.Match"
    "regexp.MatchReader"
    "regexp.MatchString"
    "regexp.Compile"
    "regexp.CompilePOSIX"
    "regexp.MustCompile"
    "regexp.MustCompilePOSIX")
  (argument_list
    .
    [
      (raw_string_literal)
      (interpreted_string_literal)
    ] @injection.content
    (#set! injection.language "regex")))

; Alpine attribute values as JavaScript.
((attribute
  name: (attribute_name) @_name
  value: (quoted_attribute_value
    (attribute_value) @injection.content))
  (#match? @_name "^(x-(show|bind|text|html|model|modelable|if|id)([:.]|$)|:)")
  (#set! injection.language "javascript"))

; A bare name in these attributes is a function reference. highlights.scm
; captures it, because injected JavaScript would highlight it as a variable.
((attribute
  name: (attribute_name) @_name
  value: (quoted_attribute_value
    (attribute_value) @injection.content))
  (#match? @_name "^(x-(data|init|on|effect)([:.]|$)|@)")
  (#not-match? @injection.content "^\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*$")
  (#set! injection.language "javascript"))
