'use strict';

const metatests = require('metatests');

const metaschema = require('..');
const { getSchemaDir } = require('./utils');

const testMs = (test, ms) => {
  test.assert(ms.domains.has('CountryName'));

  test.strictSame(ms.categories.size, 3);
  test.assert(ms.categories.has('Person'));
  test.assert(ms.categories.has('FullName'));
  test.assert(ms.categories.has('Citizenship'));

  const Person = ms.categories.get('Person');

  test.assert(Person.views.has('DOB'));
  test.assert(Person.forms.has('ChangeDOB'));
  test.assert(Person.actions.has('ChangeDOB'));

  const FullName = ms.categories.get('FullName');

  test.assert(FullName.forms.has('ChangeName'));
  test.assert(FullName.actions.has('ChangeName'));
};

metatests.test('must properly load schemas from modules', test => {
  metaschema.fs.loadAndCreate(getSchemaDir('modules'), null, (error, ms) => {
    test.error(error);

    const sources = ms.sources;
    const schemas = sources.map(schema => {
      schema.definition = metaschema.processSchema(schema.name, schema.source);
      return [schema.type, schema];
    });
    const [err, m] = metaschema.create(schemas);

    test.error(err);

    testMs(test, ms);
    testMs(test, m);
    test.end();
  });
});
