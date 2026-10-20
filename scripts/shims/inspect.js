const inspect = function (o) { try { return JSON.stringify(o); } catch (_) { return String(o); } };
inspect.custom = Symbol.for("nodejs.util.inspect.custom");
exports.inspect = inspect;
