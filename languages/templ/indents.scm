; From https://github.com/zed-industries/zed/blob/49c53bc0ec85c38f579efbbcda9a1a84fb54e51f/extensions/html/languages/html/indents.scm

[
    (assignment_statement)
    (call_expression)
    (selector_expression)
] @indent

(_ "[" "]" @end) @indent
(_ "{" "}" @end) @indent
(_ "(" ")" @end) @indent

(tag_start ">" @end) @indent
(self_closing_tag "/>" @end) @indent
(void_element ">" @end) @indent
(script_tag_start ">" @end) @indent
(self_closing_script_tag "/>" @end) @indent
(style_tag_start ">" @end) @indent
(self_closing_style_tag "/>" @end) @indent

(element
  (tag_start) @start
  (tag_end)? @end) @indent

(script_element
  (script_tag_start) @start
  (script_tag_end)? @end) @indent

(style_element
  (style_tag_start) @start
  (style_tag_end)? @end) @indent
