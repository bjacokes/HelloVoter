
import express from 'express';
import expressLogging from 'express-logging';
import expressAsync from 'express-async-await';
import cors from 'cors';
import fs from 'fs';
import uuidv4 from 'uuid/v4';
import logger from 'logops';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import http from 'http';
import neo4j from 'neo4j-driver';
import BoltAdapter from 'node-neo4j-bolt-adapter';

const ovi_config = {
  server_port: ( process.env.SERVER_PORT ? process.env.SERVER_PORT : 8080 ),
  ip_header: ( process.env.CLIENT_IP_HEADER ? process.env.CLIENT_IP_HEADER : null ),
  neo4j_host: ( process.env.NEO4J_HOST ? process.env.NEO4J_HOST : 'localhost' ),
  neo4j_user: ( process.env.NEO4J_USER ? process.env.NEO4J_USER : 'neo4j' ),
  neo4j_pass: ( process.env.NEO4J_PASS ? process.env.NEO4J_PASS : 'neo4j' ),
  jwt_pub_key: ( process.env.JWT_PUB_KEY ? process.env.JWT_PUB_KEY : 'https://raw.githubusercontent.com/OurVoiceUSA/sm-oauth/master/public.key' ),
  jwt_iss: ( process.env.JWT_ISS ? process.env.JWT_ISS : 'example.com' ),
  require_auth: ( process.env.AUTH_OPTIONAL ? false : true ),
  DEBUG: ( process.env.DEBUG ? true : false ),
};

var public_key;

// if public key starts with http, use node-fetch
if (ovi_config.jwt_pub_key.match(/^http/)) {
  fetch(ovi_config.jwt_pub_key)
    .then(res => {
      if (res.status !== 200) throw "http code "+res.status;
      return res.text()
    })
    .then(body => {
      public_key = body;
    })
    .catch((e) => {
      console.log("Unable to read JWT_PUB_KEY of "+ovi_config.jwt_pub_key);
      console.log(e);
      process.exit(1);
    });
} else {
  public_key = fs.readFileSync(ovi_config.jwt_pub_key);
}

// async'ify neo4j
const authToken = neo4j.auth.basic(ovi_config.neo4j_user, ovi_config.neo4j_pass);
const db = new BoltAdapter(neo4j.driver('bolt://'+ovi_config.neo4j_host, authToken));

cqa('return timestamp()').catch((e) => {console.error("Unable to connect to database."); process.exit(1)}).then(() => {
  cqa('create constraint on (a:Canvasser) assert a.id is unique');
  cqa('create constraint on (a:Team) assert a.name is unique');
  cqa('create constraint on (a:Turf) assert a.name is unique');
  cqa('create constraint on (a:Form) assert a.id is unique');
  cqa('create constraint on (a:Question) assert a.key is unique');
});

function valid(str) {
  if (!str) return false;
  if (!str.match(/^[0-9a-zA-Z\- '"]+$/)) return false;
  return true;
}

async function dbwrap() {
    var params = Array.prototype.slice.call(arguments);
    var func = params.shift();
    if (ovi_config.DEBUG) {
      let funcName = func.replace('Async', '');
      console.log('DEBUG: '+funcName+' '+params[0]+';'+(params[1]?' params: '+JSON.stringify(params[1]):''));
    }
    return db[func](params[0], params[1]);
}

async function cqa(q, p) {
  return dbwrap('cypherQueryAsync', q, p);
}

function cleanobj(obj) {
  for (var propName in obj) {
    if (obj[propName] == '' || obj[propName] == null)
      delete obj[propName];
  }
}

function getClientIP(req) {
  if (ovi_config.ip_header) return req.header(ovi_config.ip_header);
  else return req.connection.remoteAddress;
}

// just do a query and either return OK or ERROR

async function cqdo(req, res, q, p, a) {
  if (a === true && ovi_config.require_auth === true && req.user.admin !== true)
    return res.status(403).send({error: true, msg: "Permission denied."});

  let ref;

  try {
    ref = await cqa(q, p);
  } catch (e) {
    console.warn(e);
    return res.status(500).send({error: true, msg: "Internal server error."});
  }

  return res.status(200).send({msg: "OK", data: ref.data});
}

function poke(req, res) {
  return cqdo(req, res, 'return timestamp()', false);
}

// they say that time's supposed to heal ya but i ain't done much healin'

async function hello(req, res) {
  let ref;
  let msg = "Awaiting assignment";
  let obj = {
    ready: false,
    turf: [],
    teams: [],
    forms: [],
  };

  try {
    // if there are no admins, make this one an admin
    let ref = await cqa('match (a:Canvasser {admin:true}) return count(a)');
    if (ref.data[0] === 0) {
      await cqa('match (a:Canvasser {id:{id}}) set a.admin=true', req.user)
      req.user.admin = true;
    }

    // Butterfly in the sky, I can go twice as high.
    if (req.user.admin === true) obj.admin = true;

    // direct assignment to a form
    ref = await cqa('match (a:Canvasser {id:{id}})-[:ASSIGNED]-(b:Form) return b', req.user)
    if (ref.data.length > 0) {
      obj.forms = obj.forms.concat(ref.data);
    }

    // direct assignment to turf
    ref = await cqa('match (a:Canvasser {id:{id}})-[:ASSIGNED]-(b:Turf) return b', req.user)
    if (ref.data.length > 0) {
      obj.turf = obj.turf.concat(ref.data);
    }

    // assingment to form/turf via team
    ref = await cqa('match (a:Canvasser {id:{id}})-[:MEMBERS]-(b:Team)-[:ASSIGNED]-(c:Turf) match (d:Form)-[:ASSIGNED]-(b) return collect(distinct(b)), collect(distinct(c)), collect(distinct(d))', req.user);
    if (ref.data[0][0].length > 0) {
      obj.teams = obj.teams.concat(ref.data[0][0]);
      obj.turf = obj.turf.concat(ref.data[0][1]);
      obj.forms = obj.forms.concat(ref.data[0][2]);
    }
  } catch (e) {
    console.warn(e);
    return res.status(500).send({error: true, msg: "Internal server error."});
  }

  // TODO: dedupe, someone can be assigned directly to turf/forms and indirectly via a team
  // TODO: add questions to forms, like in formGet()

  if (obj.turf.length > 0 && obj.forms.length > 0) {
    msg = "You are assigned turf and ready to canvass!";
    obj.ready = true;
  }

  return res.send({msg: msg, data: obj});
}

// canvassers

function canvasserList(req, res) {
  return cqdo(req, res, 'match (a:Canvasser) return a');
}

async function canvasserLock(req, res) {
  if (req.body.id === req.user.id) return res.status(403).send({error: true, msg: "You can't lock yourself."});

  try {
    let ref = await cqa("match (a:Canvasser {id:{id}}) return a", req.body);
    if (ref.data[0] && ref.data[0].admin === true)
      return res.status(403).send({error: true, msg: "Permission denied."});
  } catch(e) {
    console.warn(e);
    return res.status(500).send({error: true, msg: "Internal server error."});
  }

  return cqdo(req, res, 'match (a:Canvasser {id:{id}}) set a.locked=true', req.body, true);
}

function canvasserUnlock(req, res) {
  if (!valid(req.body.id)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'id'."});
  return cqdo(req, res, 'match (a:Canvasser {id:{id}}) remove a.locked', req.body, true);
}

// teams

function teamList(req, res) {
  return cqdo(req, res, 'match (a:Team) return a');
}

function teamCreate(req, res) {
  if (!valid(req.body.name)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'name'."});
  return cqdo(req, res, 'create (a:Team {created: timestamp(), name:{name}})', req.body, true);
}

function teamDelete(req, res) {
  if (!valid(req.body.name)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'name'."});
  return cqdo(req, res, 'match (a:Team {name:{name}}) detach delete a', req.body, true);
}

function teamMembersList(req, res) {
  if (!valid(req.query.teamName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'teamName'."});
  return cqdo(req, res, 'match (a:Canvasser)-[:MEMBERS]-(b:Team {name:{teamName}}) return a', req.query);
}

function teamMembersAdd(req, res) {
  if (!valid(req.body.teamName) || !valid(req.body.cId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'teamName' or 'cId'."});
  return cqdo(req, res, 'match (a:Canvasser {id:{cId}}), (b:Team {name:{teamName}}) merge (b)-[:MEMBERS]->(a)', req.body, true);
}

function teamMembersRemove(req, res) {
  if (!valid(req.body.teamName) || valid(!req.body.cId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'teamName' or 'cId'."});
  return cqdo(req, res, 'match (a:Canvasser {id:{cId}})-[r:MEMBERS]-(b:Team {name:{teamName}}) delete r', req.body, true);
}

// turf

function turfList(req, res) {
  return cqdo(req, res, 'match (a:Turf) return a');
}

function turfCreate(req, res) {
  if (!valid(req.body.name)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'name'."});
  return cqdo(req, res, 'create (a:Turf {created: timestamp(), name:{name}})', req.body, true);
}

function turfDelete(req, res) {
  if (!valid(req.body.name)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'name'."});
  return cqdo(req, res, 'match (a:Turf {name:{name}}) detach delete a', req.body, true);
}

function turfAssignedTeamList(req, res) {
  if (!valid(req.query.turfName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'turfName'."});
  return cqdo(req, res, 'match (a:Turf {name:{turfName}})-[:ASSIGNED]-(b:Team) return b', req.query);
}

function turfAssignedTeamAdd(req, res) {
  if (!valid(req.body.turfName) || !valid(req.body.teamName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'turfName' or 'teamName'."});
  return cqdo(req, res, 'match (a:Turf {name:{turfName}}), (b:Team {name:{teamName}}) merge (a)-[:ASSIGNED]->(b)', req.body, true);
}

function turfAssignedTeamRemove(req, res) {
  if (!valid(req.body.turfName) || !valid(req.body.teamName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'turfName' or 'teamName'."});
  return cqdo(req, res, 'match (a:Turf {name:{turfName}})-[r:ASSIGNED]-(b:Team {name:{teamName}}) delete r', req.body, true);
}

function turfAssignedCanvasserList(req, res) {
  if (!valid(req.query.turfName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'turfName'."});
  return cqdo(req, res, 'match (a:Turf {name:{turfName}})-[:ASSIGNED]-(b:Canvasser) return b', req.query);
}

function turfAssignedCanvasserAdd(req, res) {
  if (!valid(req.body.turfName) || !valid(req.body.cId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'turfName' or 'cId'."});
  return cqdo(req, res, 'match (a:Turf {name:{turfName}}), (b:Canvasser {id:{cId}}) merge (a)-[:ASSIGNED]->(b)', req.body, true);
}

function turfAssignedCanvasserRemove(req, res) {
  if (!valid(req.body.turfName) || !valid(req.body.cId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'turfName' or 'cId'."});
  return cqdo(req, res, 'match (a:Turf {name:{turfName}})-[r:ASSIGNED]-(b:Canvasser {id:{cId}}) delete r', req.body, true);
}

// form

async function formGet(req, res) {
  let form = {};

  try {
    let a = await cqa('match (a:Form {id:{id}})-[:AUTHOR]-(b:Canvasser) return a,b', req.query);

    if (a.data.length === 1) {
      form = a.data[0][0];
      form.author_id = a.data[0][1].id;
      form.author = a.data[0][1].name;
      let b = await cqa('match (a:Question)-[:ASSIGNED]-(b:Form {id:{id}}) return a', req.query);
      form.questions = b.data;
    }

  } catch (e) {
    console.warn(e);
    return res.status(500).send({error: true, msg: "Internal server error."});
  }

  return res.send(form);
}

function formList(req, res) {
  return cqdo(req, res, 'match (a:Form) return a');
}

function formCreate(req, res) {
  req.body.id = uuidv4();
  req.body.author_id = req.user.id;
  return cqdo(req, res, 'match (a:Canvasser {id:{author_id}}) create (b:Form {created: timestamp(), id:{id}, name:{name}, version:1})-[:AUTHOR]->(a) return b', req.body);
}

function formDelete(req, res) {
  if (!valid(req.body.id)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'id'."});
  return cqdo(req, res, 'match (a:Form {id:{id}}) detach delete a', req.body, true);
}

function formAssignedTeamList(req, res) {
  if (!valid(req.query.id)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'id'."});
  return cqdo(req, res, 'match (a:Form {id:{id}})-[:ASSIGNED]-(b:Team) return b', req.query);
}

function formAssignedTeamAdd(req, res) {
  if (!valid(req.body.fId) || !valid(req.body.teamName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'fId' or 'teamName'."});
  return cqdo(req, res, 'match (a:Form {id:{fId}}), (b:Team {name:{teamName}}) merge (a)-[:ASSIGNED]->(b)', req.body, true);
}

function formAssignedTeamRemove(req, res) {
  if (!valid(req.body.fId) || !valid(req.body.teamName)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'fId' or 'teamName'."});
  return cqdo(req, res, 'match (a:Form {id:{fId}})-[r:ASSIGNED]-(b:Team {name:{teamName}}) delete r', req.body, true);
}

function formAssignedCanvasserList(req, res) {
  if (!valid(req.query.id)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'id'."});
  return cqdo(req, res, 'match (a:Form {id:{id}})-[:ASSIGNED]-(b:Canvasser) return b', req.query);
}

function formAssignedCanvasserAdd(req, res) {
  if (!valid(req.body.fId) || !valid(req.body.cId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'fId' or 'cId'."});
  return cqdo(req, res, 'match (a:Form {id:{fId}}), (b:Canvasser {id:{cId}}) merge (a)-[:ASSIGNED]->(b)', req.body, true);
}

function formAssignedCanvasserRemove(req, res) {
  if (!valid(req.body.fId) || !valid(req.body.cId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'fId' or 'cId'."});
  return cqdo(req, res, 'match (a:Form {id:{fId}})-[r:ASSIGNED]-(b:Canvasser {id:{cId}}) delete r', req.body, true);
}

// question

async function questionGet(req, res) {
  if (!valid(req.body.key)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'key'."});

  let q = {};

  try {
    // TODO: use cqdo() and format the code in the cypher return rather than in javascript code
    let a = await cqa('match (a:Question {key:{key}})-[:AUTHOR]-(b:Canvasser) return a,b', req.query);

    if (a.data.length === 1) {
      q = a.data[0][0];
      q.author_id = a.data[0][1].id;
      q.author = a.data[0][1].name;
    }
  } catch (e) {
    console.warn(e);
    return res.status(500).send({error: true, msg: "Internal server error."});
  }

  return res.send(q);
}

function questionList(req, res) {
  return cqdo(req, res, 'match (a:Question) return a');
}

function questionCreate(req, res) {
   if (!valid(req.body.key) || !valid(req.body.label) || !valid(req.body.type)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'key' or 'label' or 'type'."});
   req.body.author_id = req.user.id;
   return cqdo(req, res, 'match (a:Canvasser {id:{author_id}}) create (b:Question {created: timestamp(), key:{key}, label:{label}, type:{type}})-[:AUTHOR]->(a)', req.body);
}

function questionDelete(req, res) {
  if (!valid(req.body.key)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'key'."});
  return cqdo(req, res, 'match (a:Question {key:{key}}) detach delete a', req.body, true);
}

function questionAssignedList(req, res) {
  if (!valid(req.query.key)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'key'."});
  return cqdo(req, res, 'match (a:Question {key:{key}})-[:ASSIGNED]-(b:Form) return b', req.query);
}

function questionAssignedAdd(req, res) {
  if (!valid(req.body.key) || !valid(req.body.fId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'key' or 'fId'."});
  return cqdo(req, res, 'match (a:Question {key:{key}}), (b:Form {id:{fId}}) merge (a)-[:ASSIGNED]->(b)', req.body, true);
}

function questionAssignedRemove(req, res) {
  if (!valid(req.body.key) || !valid(req.body.fId)) return res.status(400).send({error: true, msg: "Invalid value to parameter 'key' or 'fId'."});
  return cqdo(req, res, 'match (a:Question {key:{key}})-[r:ASSIGNED]-(b:Form {id:{fId}}) delete r', req.body, true);
}

// Initialize http server
const app = expressAsync(express());
app.disable('x-powered-by');
app.use(expressLogging(logger));
app.use(bodyParser.json());
app.use(cors());

// require ip_header if config for it is set
if (!ovi_config.DEBUG && ovi_config.ip_header) {
  app.use(function (req, res, next) {
    if (!req.header(ovi_config.ip_header)) {
      console.log('Connection without '+ovi_config.ip_header+' header');
      res.status(400).send({error: true, msg: "Missing required header."});
    }
    else next();
  });
}

// add req.user if there's a valid JWT
app.use(async function (req, res, next) {
  if (req.method == 'OPTIONS') return next(); // skip OPTIONS requests

  req.user = {};

  // uri whitelist
  if (req.url == '/poke') return next();

  try {
    let u;
    if (ovi_config.require_auth) {
      if (!req.header('authorization')) return res.status(400).send({error: true, msg: "Missing required header."});
      u = jwt.verify(req.header('authorization').split(' ')[1]);
    } else {
      let token;
      if (req.header('authorization')) token = req.header('authorization').split(' ')[1];
      else token = (req.body.jwt?req.body.jwt:req.query.jwt);
      u = jwt.decode(token);
    }

    // verify props
    if (!u.id) return res.status(400).send({error: true, msg: "Your token is missing a required parameter."});
    if (u.iss !== ovi_config.jwt_iss) return res.status(403).send({error: true, msg: "Your token was issued for a different domain."});

    // check for this user in the database
    let a = await cqa('match (a:Canvasser {id:{id}}) return a', u);
    if (a.data.length === 1) {
      req.user = a.data[0];
      // TODO: check req.user vs. u to update name or email or avatar props
    } else {
      // attempt to create the user, some props are optional
      if (!u.email) u.email = "";
      if (!u.avatar) u.avatar = "";
      await cqa('create (a:Canvasser {created: timestamp(), id:{id}, name:{name}, email:{email}, avatar:{avatar}})', u);
      a = await cqa('match (a:Canvasser {id:{id}}) return a', u);
      req.user = a.data[0];
    }

    if (req.user.locked) return res.status(403).send({error: true, msg: "Your account is locked."});

  } catch (e) {
    console.warn(e);
    return res.status(401).send({error: true, msg: "Invalid token."});
  }
  next();
});

// internal routes
app.get('/poke', poke);

// ws routes
app.get('/canvass/v1/hello', hello);
app.get('/canvass/v1/canvasser/list', canvasserList);
app.post('/canvass/v1/canvasser/lock', canvasserLock);
app.post('/canvass/v1/canvasser/unlock', canvasserUnlock);
app.get('/canvass/v1/team/list', teamList);
app.post('/canvass/v1/team/create', teamCreate);
app.post('/canvass/v1/team/delete', teamDelete);
app.get('/canvass/v1/team/members/list', teamMembersList);
app.post('/canvass/v1/team/members/add', teamMembersAdd);
app.post('/canvass/v1/team/members/remove', teamMembersRemove);
app.get('/canvass/v1/turf/list', turfList);
app.post('/canvass/v1/turf/create', turfCreate);
app.post('/canvass/v1/turf/delete', turfDelete);
app.get('/canvass/v1/turf/assigned/team/list', turfAssignedTeamList);
app.post('/canvass/v1/turf/assigned/team/add', turfAssignedTeamAdd);
app.post('/canvass/v1/turf/assigned/team/remove', turfAssignedTeamRemove);
app.get('/canvass/v1/turf/assigned/canvasser/list', turfAssignedCanvasserList);
app.post('/canvass/v1/turf/assigned/canvasser/add', turfAssignedCanvasserAdd);
app.post('/canvass/v1/turf/assigned/canvasser/remove', turfAssignedCanvasserRemove);
app.get('/canvass/v1/form/get', formGet);
app.get('/canvass/v1/form/list', formList);
app.post('/canvass/v1/form/create', formCreate);
app.post('/canvass/v1/form/delete', formDelete);
app.get('/canvass/v1/form/assigned/team/list', formAssignedTeamList);
app.post('/canvass/v1/form/assigned/team/add', formAssignedTeamAdd);
app.post('/canvass/v1/form/assigned/team/remove', formAssignedTeamRemove);
app.get('/canvass/v1/form/assigned/canvasser/list', formAssignedCanvasserList);
app.post('/canvass/v1/form/assigned/canvasser/add', formAssignedCanvasserAdd);
app.post('/canvass/v1/form/assigned/canvasser/remove', formAssignedCanvasserRemove);
app.get('/canvass/v1/question/get', questionGet);
app.get('/canvass/v1/question/list', questionList);
app.post('/canvass/v1/question/create', questionCreate);
app.post('/canvass/v1/question/delete', questionDelete);
app.get('/canvass/v1/question/assigned/list', questionAssignedList);
app.post('/canvass/v1/question/assigned/add', questionAssignedAdd);
app.post('/canvass/v1/question/assigned/remove', questionAssignedRemove);

// Launch the server
const server = app.listen(ovi_config.server_port, () => {
  const { address, port } = server.address();
  console.log('canvass-broker express');
  console.log(`Listening at http://${address}:${port}`);
});

