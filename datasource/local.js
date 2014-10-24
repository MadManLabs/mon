var fs = require("fs");
var util = require("util");
var events = require("events");
var Perfmon = require("../perfmon.js");
var _ = require("underscore");

function LocalDataSource(argv) {
  var _this = this;

  _this.argv = argv;
}

util.inherits(LocalDataSource, events.EventEmitter);

LocalDataSource.prototype.start = function(config) {
  var _this = this;

  _this.normalize(config);

  var counters = _.chain(config.groups)
                  .map(function(group) { return [group.counters, group.lists] })
                  .flatten()
                  .compact()
                  .map(function(item) { return item.id })
                  .unique()
                  .value();

  var perfmon = new Perfmon(counters);
  perfmon.start();

  perfmon.on("data", function(data) {
    var snapshot = {
      host: data.host,
      time: data.time,
      groups: _.map(config.groups, function(group) {
        return {
          name: group.name,
          column: group.column || 1,
          counters: _.map(group.counters, function(counter) {
            var match = _.find(data.counters, function(item) { return item.name === counter.id });
            var value = match ? match.value : NaN;

            if (counter.stats) {
              if (!counter.history)
                counter.history = [];

              counter.history.push(value);
              counter.history = _.last(counter.history, _.max(_.map(counter.stats, function(stat) { return stat.count })));

              var stats = _.map(counter.stats, function(stat) {
                var value = _this.calc(_.last(counter.history, stat.count), stat.func);

                return {
                  name: stat.func + "(" + stat.count + ")",
                  value: value,
                  threshold: getThresholdByValue(value, counter.threshold)
                };
              });
            }

            return {
              name: counter.name,
              value: value,
              format: counter.format || "0,0",
              threshold: getThresholdByValue(value, counter.threshold),
              stats: stats,
            };
          }),
          lists: _.map(group.lists, function(list) {
            var regex = new RegExp(list.id.replace(/./g, function(c) { return (c === "*") ? "(.*?)" : "\\x" + c.charCodeAt(0).toString(16) }));

            var items = [];
            data.counters.forEach(function(counter) {
              var match = regex.exec(counter.name);

              if (!match)
                return;

              if (match[1][0] === "_")
                return;

              items.push({
                name: match[1],
                value: counter.value,
              });
            });

            items = _.sortBy(items, function(item) { return (list.sort === "desc" ? -1 : 1) * item.value });
            items = _.first(items, list.count);

            return {
              name: list.name,
              items: items,
              format: list.format || "0,0",
            };
          }),
        };
      })
    };

    _this.emit("snapshot", snapshot);
  });

  _this.perfmon = perfmon;

  _this.emit("start");
};

LocalDataSource.prototype.stop = function() {
  var _this = this;

  _this.perfmon.stop();
  _this.emit("stop");
};

LocalDataSource.prototype.normalize = function(config) {
  var _this = this;

  config.groups.forEach(function (group) {
    if (group.counters) {
      group.counters.forEach(function (counter, index) {
        if (_.isString(counter)) {
          counter = {
            id: counter
          };

          group.counters[index] = counter;
        }

        counter.id = counter.id.replace(/%\w+%/gi, function(match) {
          return config.variables ? config.variables[match.replace(/%/g, "")] || "" : "";
        })

        if (!counter.name)
          counter.name = /\\([^\\]+)\\(.+)/.exec(counter.id)[2];

        if (counter.threshold)
          counter.threshold = _.map(counter.threshold, function(v, k) { return {"level": k, "name": v} });

        if (counter.stats) {
          counter.stats.forEach(function(stat, index) {
            var match = /(\w+)\((\d+)\)/.exec(stat);
            if (match)
              counter.stats[index] = {
                func: match[1],
                count: match[2]
              };
          });
        }
      });
    }

    if (group.lists) {
      group.lists.forEach(function (list, index) {
        if (_.isString(group.list)) {
          list = {
            id: group.list
          };

          group.lists[index] = list;
        }

        if (!list.count)
          list.count = 5;

        if (!list.sort)
          list.sort = "desc";
      });
    }
  });
}

LocalDataSource.prototype.calc = function(data, func) {
  if (func == "sum")
    return _.reduce(data, function(memo, item) { return memo + item }, 0);

  if (func == "avg")
    return _.reduce(data, function(memo, item) { return memo + item }, 0) / data.length;
};

module.exports = LocalDataSource;

function getThresholdByValue(value, thresholds) {
  if (!thresholds)
    return null;

  return _.chain(thresholds)
          .filter(function(item) { return item.level >= value })
          .sortBy(function(item) { item.name })
          .first()
          .value();
}
