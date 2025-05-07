/***********************************************************
 * JavaScript syntax format: ES5/ES6 - ECMAScript 2015
 * Loading all required dependencies, libraries and packages
 **********************************************************/
const express = require("express");
const router = express.Router();

const Busboy = require("busboy");
const inspect = require("util").inspect;

const { sequelize } = require("../../../connection");

const logger = require("../../../logger");
const datasets = require("../models/datasets");
const csvtojson = require("csvtojson");
const Datasets = datasets.Datasets;
const makeNewDatasetTable = datasets.makeNewDatasetTable;

//Returns dataset rows based on search
router.post("/get", function (req, res, next) {
  get(req, res, next);
});
const { QueryTypes } = require("sequelize");

function get(req, res, next) {
  const queries = JSON.parse(req.body.queries);

  let results = [];
  loopedGet(0);

  async function getTableColumns(tableName) {
    // Get column names for the table from information_schema
    const columns = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = :tableName",
      {
        replacements: { tableName },
        type: QueryTypes.SELECT,
      }
    );
    return columns.map(col => col.column_name);
  }

  function loopedGet(i) {
    if (i >= queries.length) {
      res.send({
        status: "success",
        body: results,
      });
      return;
    }
    //First Find the table name
    Datasets.findOne({ where: { name: queries[i].dataset } })
      .then(async (result) => {
        if (result) {
          const tableName = result.dataValues.table;
          // Validate table name: only allow tables from Datasets table
          if (!tableName || typeof tableName !== "string") {
            loopedGet(i + 1);
            return null;
          }
          // Validate column name
          let column = queries[i].column
            .replace(/[`~!@#$%^&*|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, "")
            .replace(/[^ -~]+/g, "");
          // Get allowed columns for the table
          let allowedColumns;
          try {
            allowedColumns = await getTableColumns(tableName);
          } catch (e) {
            loopedGet(i + 1);
            return null;
          }
          if (!allowedColumns.includes(column)) {
            loopedGet(i + 1);
            return null;
          }
          // Use safe identifiers for table and column
          const safeTable = `"${tableName.replace(/"/g, "")}"`;
          const safeColumn = `"${column.replace(/"/g, "")}"`;
          sequelize
            .query(
              `SELECT * FROM ${safeTable} WHERE ${safeColumn} = :search ORDER BY id ASC LIMIT 100`,
              {
                replacements: {
                  search: queries[i].search,
                },
                type: QueryTypes.SELECT,
              }
            )
            .then((r) => {
              results.push({
                ...queries[i],
                table: tableName,
                results: r,
              });
              loopedGet(i + 1);
              return null;
            })
            .catch((err) => {
              loopedGet(i + 1);
              return null;
            });
        } else {
          loopedGet(i + 1);
        }
        return null;
      })
      .catch((err) => {
        loopedGet(i + 1);
        return null;
      });
  }
}

//Returns a list of entries in the datasets table
router.post("/entries", function (req, res, next) {
  Datasets.findAll()
    .then((sets) => {
      if (sets && sets.length > 0) {
        let entries = [];
        for (let i = 0; i < sets.length; i++) {
          entries.push({ name: sets[i].name, updated: sets[i].updatedAt });
        }
        res.send({
          status: "success",
          body: { entries: entries },
        });
      } else {
        res.send({
          status: "failure",
        });
      }
    })
    .catch((err) => {
      logger("error", "Failure finding datasets.", req.originalUrl, req, err);
      res.send({
        status: "failure",
      });
    });
});

/*
 * req.body.layer
 * req.body.key
 * req.body.value
 */
router.post("/search", function (req, res, next) {
  //First Find the table name
  Datasets.findOne({ where: { name: req.body.layer } })
    .then((result) => {
      if (result) {
        let table = result.dataValues.table;

        sequelize
          .query(
            "SELECT properties, ST_AsGeoJSON(geom) FROM " +
              table +
              " WHERE properties ->> :key = :value;",
            {
              replacements: {
                key: req.body.key,
                value: req.body.value.replace(/[`;'"]/gi, ""),
              },
            }
          )
          .then(([results]) => {
            let r = [];
            for (let i = 0; i < results.length; i++) {
              let feature = JSON.parse(results[i].st_asgeojson);
              feature.properties = results[i].properties;
              r.push(feature);
            }

            res.send({
              status: "success",
              body: r,
            });

            return null;
          })
          .catch((err) => {
            logger(
              "error",
              "SQL error search through dataset.",
              req.originalUrl,
              req,
              err
            );
            res.send({
              status: "failure",
              message: "SQL error.",
            });
          });
      } else {
        res.send({
          status: "failure",
          message: "Layer not found.",
        });
      }

      return null;
    })
    .catch((err) => {
      logger("error", "Failure finding dataset.", req.originalUrl, req, err);
      res.send({
        status: "failure",
      });
    });
});

router.post("/upload", function (req, res, next) {
  // Disable timeout
  req.setTimeout(0);

  let fields = {
    name: null,
    header: null,
    upsert: null,
  };

  let tableName = null;
  let tableObj = null;

  if (req.isLongTermToken) {
    let internalHeader = [];
    const maxRowsAtATime = 10000;
    let populateInterval = null;
    let working = false;
    let uploaded = "";
    let uploadFinished = false;
    const busboy = new Busboy({ headers: req.headers });
    busboy.on("file", function (fieldname, file, filename, encoding, mimetype) {
      file.on("data", function (data) {
        uploaded += data.toString("utf8");
        populateNext();
      });
      file.on("end", function () {});
    });
    busboy.on(
      "field",
      function (
        fieldname,
        val,
        fieldnameTruncated,
        valTruncated,
        encoding,
        mimetype
      ) {
        fields[fieldname] = val;
        if (
          fields.name != null &&
          fields.header != null &&
          fields.upsert != null
        )
          begin();
      }
    );
    busboy.on("finish", function () {
      uploadFinished = true;
      populateInterval = setInterval(populateNext, 100);
    });
    req.pipe(busboy);

    let totalPopulates = 0;
    let successfulPopulates = 0;
    function populateNext() {
      if (working || tableObj == null) return;
      working = true;

      if (uploadFinished && uploaded.indexOf("\n") == -1) {
        clearInterval(populateInterval);
        if (fields.upsert === "true") {
          let condition = "";
          fields.header.forEach((elm) => {
            elm = elm.replace(/[`~!@#$%^&*|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, "");
            condition +=
              ' AND ( a."' +
              elm +
              '" = b."' +
              elm +
              '" OR ( a."' +
              elm +
              '" is null AND b."' +
              elm +
              '" is null ) )';
          });

          sequelize
            .query(
              "DELETE FROM " +
                tableName +
                " a USING " +
                tableName +
                " b " +
                "WHERE b.id < a.id" +
                condition
            )
            .then(() => {
              res.send({
                status:
                  successfulPopulates == totalPopulates ? "success" : "failure",
                message:
                  successfulPopulates +
                  " out of " +
                  totalPopulates +
                  " chunks successfully uploaded. Data has been upserted too.",
                body: {},
              });
              res.end();
            })
            .catch((err) => {
              logger(
                "error",
                "Upload but failed to remove duplicated rows.",
                req.originalUrl,
                req,
                err
              );
              res.send({
                status: "failed",
                message: "Upload but failed to remove duplicated rows.",
              });
            });
        } else {
          res.send({
            status:
              successfulPopulates == totalPopulates ? "success" : "failure",
            message:
              successfulPopulates +
              " out of " +
              totalPopulates +
              " chunks successfully uploaded",
            body: {},
          });
          res.end();
        }
        return;
      }

      if (internalHeader.length == 0 && uploaded.indexOf("\n") > -1) {
        let nl = uploaded.indexOf("\n");
        internalHeader = uploaded.substring(0, nl).split(",");
        uploaded = uploaded.substring(nl + 2);
        working = false;
      } else {
        let csv = [];
        while (csv.length < maxRowsAtATime && uploaded.indexOf("\n") > -1) {
          let nl = uploaded.indexOf("\n");
          let row = uploaded.substring(0, nl).split(",");
          uploaded = uploaded.substring(nl + 2);
          let r = {};
          for (let i in internalHeader) r[internalHeader[i]] = row[i];
          csv.push(r);
        }
        totalPopulates++;
        populateDatasetTable(tableObj, csv, function (success) {
          working = false;
          if (success) successfulPopulates++;
        });
      }
    }
  }

  function begin() {
    try {
      fields.header = JSON.parse(fields.header);
      if (typeof fields.header.forEach != "function") throw "Not an array";
    } catch (err) {
      res.send({
        status: "failed",
        message: "The field 'header' is not valid json array.",
      });
      res.end();
      return;
    }
    makeNewDatasetTable(fields.name, fields.header, function (result) {
      let checkEnding = result.table.split("_");
      if (checkEnding[checkEnding.length - 1] !== "datasets") {
        logger("error", "Malformed table name.", req.originalUrl, req);
        res.send({
          status: "failed",
          message: "Malformed table name",
        });
        return;
      }

      tableName = result.table;

      if (fields.upsert === "true") {
        tableObj = result.tableObj;
      } else {
        sequelize
          .query("TRUNCATE TABLE " + result.table + " RESTART IDENTITY")
          .then(() => {
            tableObj = result.tableObj;
          })
          .catch((err) => {
            logger("error", "Recreation error.", req.originalUrl, req, err);
            res.send(result);
          });
      }
    });
  }

  function populateDatasetTable(Table, csv, cb) {
    Table.bulkCreate(csv, {
      returning: true,
    })
      .then(function (response) {
        cb(true);
      })
      .catch(function (err) {
        logger(
          "error",
          "Datasets: Failed to populate a dataset table!",
          req.originalUrl,
          req,
          err
        );
        cb(false);
        return null;
      });
  }
});

router.post("/recreate", function (req, res, next) {
  // Disable timeout
  req.setTimeout(0);

  makeNewDatasetTable(
    req.body.name || req.fields.name,
    req.body.header || JSON.parse(req.fields.header),
    function (result) {
      let checkEnding = result.table.split("_");
      if (checkEnding[checkEnding.length - 1] !== "datasets") {
        logger("error", "Malformed table name.", req.originalUrl, req);
        res.send({
          status: "failed",
          message: "Malformed table name",
        });
        return;
      }

      if (req.body.mode == "full") {
        sequelize
          .query("TRUNCATE TABLE " + result.table + " RESTART IDENTITY")
          .then(() => {
            populateDatasetTable(
              result.tableObj,
              JSON.parse(req.body.csv),
              function (success) {
                res.send({
                  status: success == true ? "success" : "failure",
                  message: "",
                  body: {},
                });
              }
            );

            return null;
          })
          .catch((err) => {
            logger("error", "Recreation error.", req.originalUrl, req, err);
            res.send(result);
          });
      } else if (req.body.mode == "append") {
        populateDatasetTable(
          result.tableObj,
          JSON.parse(req.body.csv),
          function (success) {
            res.send({
              status: success == true ? "success" : "failure",
              message: "",
              body: {},
            });
          }
        );
      }
    },
    function (result) {
      res.send(result);
    }
  );

  function populateDatasetTable(Table, csv, cb) {
    Table.bulkCreate(csv, {
      returning: true,
    })
      .then(function (response) {
        cb(true);
      })
      .catch(function (err) {
        logger(
          "error",
          "Datasets: Failed to populate a dataset table!",
          req.originalUrl,
          req,
          err
        );
        cb(false);
        return null;
      });
  }
});

module.exports = router;
