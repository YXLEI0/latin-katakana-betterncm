var fs = require("fs");
["letters", "correct", "learn"].forEach(function (n) {
  var s = fs.readFileSync("C:/dsh/western-katakana/src/core/" + n + ".js", "utf8");
  function c(ch) { return s.split(ch).length - 1; }
  console.log(n,
    "U201C", c("\u201C"),
    "U201D", c("\u201D"),
    "U300C", c("\u300C"),
    "ASCIIquote", c(String.fromCharCode(34)),
    "emdash", c("\u2014"),
    "arrow", c("->"));
});
