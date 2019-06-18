
import {
  volunteerAssignments,
  valid, _400, _403, _500
} from '../../../lib/utils';

const Router = require('express').Router

module.exports = Router({mergeParams: true})
.get('/people/get/byposition', async (req, res) => {
  req.query.longitude = parseFloat(req.query.longitude);
  req.query.latitude = parseFloat(req.query.latitude);

  if (isNaN(req.query.longitude) || isNaN(req.query.latitude)) return _400(res, "Invalid value to parameters 'longitude' or 'latitude'.");

  return visitsAndPeople(req, res);
})
.get('/people/get/byaddress', async (req, res) => {
  if (!req.query.aId) return _400(res, "Invalid value to parameter 'aId'.");

  return visitsAndPeople(req, res);
})
.post('/people/visit/add', async (req, res) => {
  if (!ov_config.volunteer_add_new) return _403(res, "Permission denied.");
  req.addnewperson = true;
  return peopleVisitUpdate(req, res);
})
.post('/people/visit/update', async (req, res) => {
  let ref = {};

  if (!req.body.deviceId) return _400(res, "Invalid value to parameter 'deviceId'.");
  if (!req.body.addressId) return _400(res, "Invalid value to parameter 'addressId'.");
  if (!req.body.formId) return _400(res, "Invalid value to parameter 'formId'.");

  req.body.status = parseInt(req.body.status);
  req.body.start = parseInt(req.body.start);
  req.body.end = parseInt(req.body.end);
  req.body.longitude = parseFloat(req.body.longitude);
  req.body.latitude = parseFloat(req.body.latitude);

  if (isNaN(req.body.status) || [0,1,2,3].indexOf(req.body.status) === -1) return _400(res, "Invalid value to parameter 'status'.");
  if (isNaN(req.body.start)) return _400(res, "Invalid value to parameter 'start'.");
  if (isNaN(req.body.end)) return _400(res, "Invalid value to parameter 'end'.");
  if (isNaN(req.body.longitude)) return _400(res, "Invalid value to parameter 'longitude'.");
  if (isNaN(req.body.latitude)) return _400(res, "Invalid value to parameter 'latitude'.");

  // TODO: make sure start and end aren't wacky (end is before start, or either is newer than now)

  // personId required if they are home or no longer live there
  if ((req.body.status === 1 || req.body.status === 3) && !req.body.personId) return _400(res, "Invalid value to parameter 'personId'.");

  // attrs is required if status is home
  if (req.body.status === 1 && typeof req.body.attrs !== 'object') return _400(res, "Invalid value to parameter 'attrs'.");

  let ass = await volunteerAssignments(req);
  if (!ass.ready) return _403(res, "Volunteer is not assigned.");

  // make sure formId is in ass.forms
  if (ass.forms.map(f => f.id).indexOf(req.body.formId) === -1) return _403(res, "You are not assigned this form.");

  req.body.autoturf_dist = 1000;

  try {
    req.body.id = req.user.id;

    if (req.addnewperson) {
      // TODO: require leader permissions

      // ensure this ID doesn't already exist
      let ref = await req.db.query('match (p:Person {id:{personId}}) return count (p)', req.body);

      if (ref.data[0] > 0) return _403(res, "Person already exists.");

      await req.db.query('match (a:Address {id:{addressId}})'+(req.body.unit?'<-[:AT]-(u:Unit {name:{unit}})':'')+' create (p:Person {id:{personId}}) create (p)-[r:RESIDENCE {current:true}]->'+(req.body.unit?'(u)':'(a)'), req.body);
    }

/*
TODO: constrain update to a turf their assigned to, but without creating multiple visits due to multiple assignments
  optional match (t:Turf)-[:ASSIGNED]->(:Team)-[:MEMBERS]->(v)
    with v, collect(t.id) as tt
  optional match (t:Turf)-[:ASSIGNED]->(v)
    with v, tt + collect(t.id) as turfIds
`+((req.user.admin||req.user.autoturf)?'optional ':'')+`match (t:Turf) where t.id in turfIds
    with v
  match `+(req.body.personId?'(p:Person {id:{personId}})-[r:RESIDENCE {current:true}]->':'')+(req.body.unit?'(u:Unit {name:{unit}})-[:AT]->':'')+`(a:Address {id:{addressId}})-[:WITHIN]->(t)

...
    with distinct(p) as p, r
*/
    ref = await req.db.query(`
  match (v:Volunteer {id:{id}})
  match `+(req.body.personId?'(p:Person {id:{personId}})-[r:RESIDENCE {current:true}]->':'')+(req.body.unit?'(u:Unit {name:{unit}})-[:AT]->':'')+`(a:Address {id:{addressId}})
`+((!req.user.admin&&req.user.autoturf)?`
    using index a:Address(id)
      where distance(a.position, v.location) < {autoturf_dist}
`:'')+`
  match (d:Device {UniqueID:{deviceId}})-[:USED_BY]->(v),
    (f:Form {id:{formId}})
  create (vi:Visit {
    start: toInteger({start}),
    end: toInteger({end}),
    status: toInt({status}),
    uploaded: timestamp(),
    position: point({longitude: {longitude}, latitude: {latitude}})
  })
  merge (vi)-[:VISIT_DEVICE]->(d)
  merge (vi)-[:VISIT_VOLUNTEER]->(v)
  merge (vi)-[:VISIT_AT]->(`+(req.body.unit?'u':'a')+`)
  merge (vi)-[:VISIT_FORM]->(f)
`+(req.body.personId?`
  merge (vi)-[:VISIT_PERSON]->(p)
`+(req.body.status===3?`
    set r.current = false, r.updated = timestamp()
`:`
    with vi, p
  unwind {attrs} as attr
  match (a:Attribute {id:attr.id})
    optional match (a)<-[:ATTRIBUTE_TYPE]-(:PersonAttribute)-[par:ATTRIBUTE_OF {current:true}]->(p)
      set par.current = false, par.updated = timestamp()
  merge (p)<-[ao:ATTRIBUTE_OF]-(pa:PersonAttribute {value:attr.value})-[:ATTRIBUTE_TYPE]->(a)
    set ao.current = true, a.updated = timestamp()
  merge (vi)-[:VISIT_PATTR]->(pa)
`):'')+`
  return count(vi)
    `, req.body);
  } catch (e) {
    return _500(res, e);
  }

  // if nothing was returned, they had all the right params but it didn't match up with the dataset somehow
  // return the "Unprocessable Entity" http error code
  if (!ref.data[0]) return _422(res, "Query returned no data. Something went wrong with your request.");

  return res.json(ref.data);
});

async function visitsAndPeople(req, res) {
  let ref = {};

  if (req.query.limit) req.query.limit = parseInt(req.query.limit);
  if (req.query.dist) req.query.dist = parseInt(req.query.dist);

  req.query.id = req.user.id;
  req.query.visit_status = [0,1,2,3];

  let empty_addrs = (req.user.admin?true:false);

  // no value? no key
  if (!req.query.filter_val) req.query.filter_key = null;
  // even if admin, a filter removes this
  if (req.query.filter_key) empty_addrs = false;
  // type convert value if needed
  switch (req.query.filter_val) {
    case "TRUE": req.query.filter_val = true; break;
    case "FALSE": req.query.filter_val = false; break;
    default: break;
  }

  // TODO: we need an isLeader ... where admin is a leader too

  // non-admin limits
  if (!req.user.admin) {
    // non-admin requires formId so they can't see what's already been interacted with on this form
    if (!req.query.formId) return _400(res, "Invalid value to parameter 'formId'.");
/*
    // TODO: system settings and team/individual permissions for dist/limit, etc by regular volunteer
    req.query.limit = 25; // TODO: server setting for this?
    req.query.dist = 1000; // TODO: this too?
    req.query.visit_status = [0,2]; // pick up 'not interested' here so we can filter the address/unit entirely
*/
  }

  if (!req.query.limit) req.query.limit = 1000;
  if (!req.query.dist) req.query.dist = 10000;

  // poll assignments to get autoturf
  await volunteerAssignments(req);

  req.query.autoturf_dist = 1000;

  try {
    // in rural areas this query can return zero -- retry with an order of magnatude incrasea ... twice if we have to
    let retry = 0;
    // don't retry on autoturf
    if (!empty_addrs && req.user.autoturf) retry = 2;

    while (retry <= 2) {
      if (retry && req.query.dist <= 100000) req.query.dist *= 10;

      let q = `match (v:Volunteer {id:{id}}) `;

      // non-admins are constrained to turf
      if (!req.user.admin) q += `
  optional match (t:Turf)-[:ASSIGNED]->(:Team)-[:MEMBERS]->(v)
    with v, collect(t.id) as tt
  optional match (t:Turf)-[:ASSIGNED]->(v)
    with v, tt + collect(t.id) as turfIds
  `+(req.user.autoturf?`optional `:``)+`match (t:Turf) where t.id in turfIds
    with v, t, turfIds `;

      // either target an address, or use the address index
      if (req.query.aId) q += `match (a:Address {id:{aId}}) `;
      else q += `match (a:Address) using index a:Address(position) `;

      if (!req.user.admin||(req.user.admin&&!req.query.aId)) q += `where `;

      if (!req.user.admin) q += `(a)-[:WITHIN]->(t) `;
      if (!req.user.admin && req.user.autoturf) q += `or distance(a.position, v.location) < {autoturf_dist} `;

      if (!req.query.aId) q += (req.user.admin?``:`and `)+`distance(a.position, point({longitude: {longitude}, latitude: {latitude}})) < {dist}
    with a, distance(a.position, point({longitude: {longitude}, latitude: {latitude}})) as dist
    order by dist limit {limit} `;

      q += `optional match (u:Unit)-[:AT]->(a) with a, u optional match (person:Person)-[:RESIDENCE {current:true}]->(u) `;

      if (req.query.filter_key) q += `where ((u)<-[:RESIDENCE {current:true}]-(:Person)<-[:ATTRIBUTE_OF {current:true}]-(:PersonAttribute {value:{filter_val}})-[:ATTRIBUTE_TYPE]->(:Attribute {id:{filter_key}}) or (person)<-[:ATTRIBUTE_OF {current:true}]-(:PersonAttribute {value:{filter_val}})-[:ATTRIBUTE_TYPE]->(:Attribute {id:{filter_key}})) `;

      if (req.query.filter_visited) q += (req.query.filter_key?`and`:`where`)+` not (person)<-[:VISIT_PERSON]-(:Visit)-[:VISIT_FORM]->(:Form {id:{formId}}) `;

      q += `optional match (attr:Attribute)<-[:ATTRIBUTE_TYPE]-(pattr:PersonAttribute)-[:ATTRIBUTE_OF {current:true}]->(person)
    with a, u, person, collect({id:attr.id, name:attr.name, value:pattr.value}) as attrs
    with a, u, collect(person{.*, attrs:attrs}) as people `;

      if (!empty_addrs&&req.query.formId) q += `where size(people) > 0 or u is null `;

      if (req.query.formId) q += `optional match (u)<-[:VISIT_AT]-(v:Visit)-[:VISIT_FORM]->(:Form {id:{formId}}) where v.status in {visit_status} with a, u, people, collect(v) as visits `+(req.user.admin?``:`, collect(v.status) as status where not 2 in status or status is null `);

      q += `
    with a, u{.*, people: people`+(req.query.formId?`, visits: visits`:``)+`} as unit
    with a, collect(unit) as units
  optional match (person:Person)-[:RESIDENCE {current:true}]->(a) `;

      if (req.query.filter_key) q += `where ((a)<-[:RESIDENCE {current:true}]-(:Person)<-[:ATTRIBUTE_OF {current:true}]-(:PersonAttribute {value:{filter_val}})-[:ATTRIBUTE_TYPE]->(:Attribute {id:{filter_key}}) or (person)<-[:ATTRIBUTE_OF {current:true}]-(:PersonAttribute {value:{filter_val}})-[:ATTRIBUTE_TYPE]->(:Attribute {id:{filter_key}})) `;

      if (req.query.filter_visited) q += (req.query.filter_key?`and`:`where`)+` not (person)<-[:VISIT_PERSON]-(:Visit)-[:VISIT_FORM]->(:Form {id:{formId}}) `;

      q += `
  optional match (attr:Attribute)<-[:ATTRIBUTE_TYPE]-(pattr:PersonAttribute)-[:ATTRIBUTE_OF {current:true}]->(person)
    with a, units, person, collect({id:attr.id, name:attr.name, value:pattr.value}) as attrs
    with a, units, a.position as ap, collect(person{.*, attrs: attrs}) as people `;

      if (req.query.formId) q += `optional match (a)<-[:VISIT_AT]-(v:Visit)-[:VISIT_FORM]->(:Form {id:{formId}}) where v.status in {visit_status} with a, units, ap, people, collect(v) as visits, collect(v.status) as status `;

      if (!empty_addrs&&req.query.formId) q += `where (size(people) > 0 or size(units) > 0) and (not 2 in status or status is null) `;

      q += `return collect({address: a{longitude:ap.x,latitude:ap.y,.id,.street,.city,.state,.zip,.updated}, units: units, people: people`+(req.query.formId?`, visits: visits`:``)+`}) as data`;

      ref = await req.db.query(q, req.query);

      if (ref.data[0].length) return res.json(ref.data[0]);

      // retry if not over limit
      retry++;
    }

  } catch (e) {
    return _500(res, e);
  }

  return res.json([]);
}
