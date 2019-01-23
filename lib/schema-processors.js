'use strict';

const { Enum, Flags, iter } = require('@metarhia/common');

const {
  getCategoryType,
  getReferenceType,
  extractDecorator,
  extractByPath,
} = require('./schema-utils');

const { SchemaValidationError, MetaschemaError } = require('./schema-errors');

const domainConstructors = { Enum, Flags };
const hierarchicalRelations = ['Catalog', 'Subdivision', 'Hierarchy', 'Master'];

// Verifies that there could be link from source category to destination
//   source - <Object>
//   sourceName - <string>
//   destination - <Object>
//   destinationName - <string>
//   propertyName - <string>
// Returns: <SchemaValidationError> | <null> information about error or null
//   if link is valid
const verifyLink = (source, destination, propertyName) => {
  const sourceType = getCategoryType(source.definition);
  const destinationType = getCategoryType(destination.definition);

  if (destinationType === 'Log') {
    return new SchemaValidationError('linkToLog', source.name, propertyName);
  }

  if (destinationType === 'Local' && sourceType !== 'Local') {
    return new SchemaValidationError(
      'illegalLinkToLocal',
      source.name,
      propertyName,
      { destination: destination.name }
    );
  }

  return null;
};

// Add a Class property to a definition of Enum and Flags
//   ms - <Metaschema>
const processDomains = ms => {
  for (const definition of ms.domains.values()) {
    const domainKind = extractDecorator(definition);
    const domainConstructor = domainConstructors[domainKind];
    if (domainConstructor) {
      const values = definition.values;
      definition.Class = domainConstructor.from(...values);
    }
  }
};

// Crosslink loaded categories
//   ms - <Metaschema>
// Returns: <MetaschemaError> | <null>
const processCategories = ms => {
  const errors = [];
  for (const category of ms.categories.values()) {
    for (const [fieldName, field] of Object.entries(category.definition)) {
      if (field.domain) {
        const domain = ms.domains.get(field.domain);
        if (domain) {
          field.definition = domain;
        } else {
          errors.push(
            new SchemaValidationError(
              'unresolvedDomain',
              category.name,
              fieldName,
              { domain: field.domain }
            )
          );
        }
      } else if (field.category) {
        const destination = ms.categories.get(field.category);
        if (!destination) {
          errors.push(
            new SchemaValidationError(
              'unresolvedCategory',
              category.name,
              fieldName,
              { category: field.category }
            )
          );
          continue;
        }
        const error = verifyLink(category, destination, fieldName);
        if (error) {
          errors.push(error);
          continue;
        }
        field.definition = destination.definition;

        const decorator = extractDecorator(field);
        for (const decor of hierarchicalRelations) {
          if (decorator === decor) {
            const property = decorator.toLowerCase();
            if (category[property]) {
              errors.push(
                new SchemaValidationError('duplicate', category.name, null, {
                  entity: decor,
                })
              );
            } else {
              category[property] = fieldName;
            }
          }
        }

        const type = getReferenceType(decorator);
        destination.references[type].push({
          category: category.name,
          property: fieldName,
        });
      }
    }
  }
  return errors.length ? new MetaschemaError(errors) : null;
};

const processFields = (ms, category, fields, info) => {
  const errors = [];
  for (const [key, field] of Object.entries(fields)) {
    if (field.domain) {
      const def = ms.domains.get(field.domain);
      if (!def) {
        errors.push(
          new SchemaValidationError(
            'unresolvedDomain',
            info.source,
            `${info.property}.${key}`,
            { domain: field.domain }
          )
        );
      } else {
        Object.assign(field, { domain: field.domain, definition: def });
      }
    } else {
      try {
        const inf = { ...info };
        inf.property += `.${key}`;
        const def = extractByPath(category, field.field, ms, inf);
        Object.assign(field, def);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  return errors;
};

const processForms = ms => {
  const errors = [];
  for (const category of ms.categories.values()) {
    for (const form of category.forms.values()) {
      errors.push(
        ...processFields(ms, category.definition, form.definition.Fields, {
          source: `${category.name}.${form.name}`,
          property: 'Fields',
        })
      );
    }
  }
  return errors.length === 0 ? null : new MetaschemaError(errors);
};

const processView = (source, view, ms) => {
  const errors = [];

  if (!Array.isArray(view.definition.Fields)) {
    return errors;
  }

  const fields = {};

  for (const field of view.definition.Fields) {
    const props = typeof field === 'string' ? { [field]: field } : field;
    for (const key in props) {
      const prop = props[key];
      if (typeof prop !== 'string') {
        fields[key] = prop;
        continue;
      }

      let schema = ms.categories.get(view.definition.Base);
      if (!schema) {
        schema = ms.categories
          .get(view.category)
          .views.get(view.definition.Base);
        errors.push(...processView(view.Base, schema, ms));
      }

      try {
        fields[key] = extractByPath(schema.definition, prop, ms, {
          source,
          property: `Fields.${key}`,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  }

  view.definition.Fields = fields;

  return errors;
};

const processViews = ms => {
  const errors = [];
  for (const category of ms.categories.values()) {
    for (const view of category.views.values()) {
      errors.push(...processView(`${category.name}.${view.name}`, view, ms));
    }
  }
  return errors.length === 0 ? null : new MetaschemaError(errors);
};

// TODO(lundibundi): remove and replace once
// https://github.com/metarhia/metaschema/pull/125 lands
const setEnumField = (ms, def, field, domainName) => {
  if (!domainName) domainName = field;
  const domain = ms.domains.get(domainName);
  if (def[field] && def[field].constructor.name !== 'EnumClass') {
    const enumClass = Enum.from(...domain.values);
    def[field] = enumClass.from(def[field]);
  }
};

const processAction = (action, category, ms) => {
  const errors = [];
  const def = action.definition;

  setEnumField(ms, def, 'Type', 'ActionType');
  setEnumField(ms, def, 'TransactionMode');
  setEnumField(ms, def, 'ProcessMode');
  setEnumField(ms, def, 'RefreshMode');

  errors.push(
    ...processFields(ms, category.definition, def.Args, {
      source: `${category.name}.${action.name}`,
      property: 'Args',
    })
  );
  errors.push(
    ...processFields(ms, category.definition, def.Returns, {
      source: `${category.name}.${action.name}`,
      property: 'Returns',
    })
  );

  const formName = def.Form || action.name;
  const form = category.forms.get(formName);

  if (form) {
    iter(Object.keys(def.Args))
      .filter(arg => !!form.definition.Fields[arg])
      .each(arg =>
        errors.push(
          new SchemaValidationError(
            'duplicateName',
            `${category.name}.${action.name}.Args`,
            arg,
            { location: `${category.name}.${formName}.Fields` }
          )
        )
      );

    action.form = form.definition;
  }

  return errors;
};

const processActions = ms => {
  const errors = [];
  for (const category of ms.categories.values()) {
    for (const action of category.actions.values()) {
      errors.push(...processAction(action, category, ms));
    }
  }
  return errors.length === 0 ? null : new MetaschemaError(errors);
};

module.exports = {
  processDomains,
  processCategories,
  processForms,
  processViews,
  processActions,
};
