'use strict';

const { iter, Int64, Uint64, Money } = require('@metarhia/common');

const {
  SchemaValidationError,
  ValidationError,
  MetaschemaError,
} = require('./schema-errors');

const { REFERENCE_TYPES, extractDecorator } = require('./schema-utils');

const {
  processDomains,
  processCategories,
  processActions,
  processViews,
  processForms,
} = require('./schema-processors');

const factorify = Symbol('factorify');
const validate = Symbol('validate');

const classWrappers = {
  Money: value => {
    try {
      return new Money(value);
    } catch (e) {
      return null;
    }
  },
  Uint8Array: value => {
    try {
      return Uint8Array.from(value);
    } catch (e) {
      return null;
    }
  },
  HashMap: value => {
    try {
      return new Map(value);
    } catch (e) {
      return null;
    }
  },
  HashSet: value => {
    try {
      return new Set(value);
    } catch (e) {
      return null;
    }
  },
  Date: value => {
    const date = new Date(value);
    return Number.isNaN(Number(date)) ? null : date;
  },
};

const domainValidators = {
  string: (domain, prop, value) => {
    const errors = [];
    if (domain.min !== undefined && value.length < domain.min) {
      errors.push(new ValidationError('domainValidation', prop, 'min'));
    }
    if (domain.length !== undefined && value.length > domain.length) {
      errors.push(new ValidationError('domainValidation', prop, 'length'));
    }
    return errors;
  },
  number: (domain, prop, value) => {
    const errors = [];
    // The condition is inverted because of possible NaN
    if (domain.min !== undefined && !(value >= domain.min)) {
      errors.push(new ValidationError('domainValidation', prop, 'min'));
    }
    // The condition is inverted because of possible NaN
    if (domain.max !== undefined && !(value <= domain.max)) {
      errors.push(new ValidationError('domainValidation', prop, 'max'));
    }
    if (domain.subtype === 'int' && !Number.isInteger(value)) {
      errors.push(new ValidationError('domainValidation', prop, 'subtype'));
    }
    return errors;
  },
  object: (domain, prop, value) => {
    const errors = [];
    const valueClass = value.constructor.name;
    if (domain.class !== valueClass) {
      errors.push(
        new ValidationError('invalidClass', prop, {
          expected: domain.class,
          actual: valueClass,
        })
      );
      return errors;
    }

    if (
      domain.length !== undefined &&
      (value.length === undefined || value.length > domain.length)
    ) {
      errors.push(new ValidationError('domainValidation', prop, 'length'));
    }

    return errors;
  },
  bigint: () => [],
  boolean: () => [],
  function: () => [],
  symbol: () => [],
};

// Validates value against a domain
//   value <any>
//   path <string>
//   domain <Object>
// Returns: <ValidationError[]>
const validateDomain = (value, path, domain) => {
  const errors = [];
  const domainType = extractDecorator(domain);

  if (domain.type) {
    const type = typeof value;
    if (type !== domain.type) {
      errors.push(
        new ValidationError('invalidType', path, {
          expected: domain.type,
          actual: type,
        })
      );
      return errors;
    }

    const validator = domainValidators[type];
    errors.push(...validator(domain, path, value));
  }

  if (domainType === 'Enum') {
    if (!domain.values.includes(value)) {
      errors.push(
        new ValidationError('enum', path, {
          expected: domain.values,
          actual: value,
        })
      );
    }
  }

  if (domainType === 'Flags') {
    const valueClass = value.constructor.name;
    if (valueClass !== 'Uint64' && valueClass !== 'FlagsClass') {
      errors.push(
        new ValidationError('invalidClass', path, {
          expected: ['Uint64', 'FlagsClass'],
          actual: valueClass,
        })
      );
    }
  }

  if (domain.check && !domain.check(value)) {
    errors.push(new ValidationError('domainValidation', path, 'check'));
  }

  return errors;
};

const validateLink = (value, path, definition, ms, patch) => {
  const errors = [];
  const category = definition.definition;
  const type = extractDecorator(definition);

  if (type === 'Include') {
    return ms[validate](category, value, patch, `${path}.`);
  }

  const checkLink = (value, path) => {
    const valueClass = value.constructor.name;
    if (valueClass !== 'Uint64' && valueClass !== 'String') {
      errors.push(
        new ValidationError('invalidClass', path, {
          expected: ['Uint64', 'String'],
          actual: valueClass,
        })
      );
    }
  };

  if (type === 'Many') {
    if (!Array.isArray(value)) {
      errors.push(
        new ValidationError('invalidType', `${path}`, {
          expected: 'Array',
          actual: typeof value,
        })
      );
    } else {
      value.forEach((val, index) => checkLink(val, `${path}[${index}]`));
    }
  } else {
    checkLink(value, path);
  }

  return errors;
};

class Metaschema {
  constructor() {
    this.domains = new Map();
    this.categories = new Map();
    this.sources = [];
  }

  // Create domain instance
  //   name <string> domain name
  //   value <any> value to check/create
  // Returns: instance of domain
  createDomainInstance(name, value) {
    const domain = this.domains.get(name);
    const decorator = extractDecorator(domain);
    if (domain.normalize) value = domain.normalize(value);
    if (domain.parse) return domain.parse(value);
    if (decorator === 'Enum') {
      const valid = domain.Class.has(value);
      return valid ? domain.Class.from(value) : null;
    }
    if (decorator === 'Flags') {
      if (typeof value === 'string' || typeof value === 'number') {
        return domain.Class.from(new Uint64(value));
      }
      const valid =
        Array.isArray(value) && value.every(v => domain.Class.has(v));
      return valid ? domain.Class.from(...value) : null;
    }
    const type = typeof value;
    const expected = domain.type;
    if (expected === 'bigint') return new Int64(value);
    if (expected === 'object') {
      const classWrapper = classWrappers[domain.class];
      return classWrapper ? classWrapper(value) : null;
    }
    return type === expected ? value : null;
  }

  // Create category instance
  //   name <string> category name
  //   value <any[]> value to check/create
  // Returns: instance of category
  createInstance(name, ...args) {
    if (!this.categories.has(name)) return null;
    return this.categories.get(name).factory(...args);
  }

  // Create factory from category definition
  //   name <string> category name
  //   definition <Object> category definition
  // Returns: function, (...args)
  [factorify](name, definition) {
    const properties = Object.keys(definition);
    const factory = (...args) => {
      let instance = args[0];
      if (args.length > 1) instance = args;
      const obj = {};
      let fields, len, field, value;
      const isArr = Array.isArray(instance);
      if (isArr) {
        len = Math.min(properties.length, instance.length);
      } else {
        fields = Object.keys(instance).filter(field =>
          properties.includes(field)
        );
        len = fields.length;
      }
      for (let i = 0; i < len; i++) {
        if (isArr) {
          field = properties[i];
          value = instance[i];
        } else {
          field = fields[i];
          value = instance[field];
        }
        const def = definition[field];
        if (typeof def === 'function') {
          value = def(value);
          obj[field] = value;
        } else {
          if (def.category) {
            if (typeof value === 'object') {
              value = this.createInstance(def.category, value);
            } else {
              value = new Int64(value);
            }
          }
          if (def.domain) value = this.createDomainInstance(def.domain, value);
          if (value !== null) obj[field] = value;
          else return null;
        }
      }
      for (const prop of properties) {
        const def = definition[prop];
        if (!obj.hasOwnProperty(prop)) {
          if (def.default) {
            const value = this.createDomainInstance(def.domain, def.default);
            if (value === null) return null;
            obj[prop] = value;
          } else if (def.required) {
            return null;
          }
        }
      }
      return obj;
    };
    return factory;
  }

  // Validate object against a schema
  //   schema <Object>, schema to validate against
  //   object <Object>, object to validate
  //   patch <boolean>, flag to determine if the object contains patch or
  //       value, default: `false`
  //   path <string>, path to an object, for nested objects, default: `''`
  // Returns: <ValidationError[]>
  [validate](schema, object, patch = false, path = '') {
    const errors = [];
    const schemaProps = new Set(Object.keys(schema));
    const objectProps = new Set(Object.keys(object));
    const props = new Set([...schemaProps, ...objectProps]);
    for (const prop of props) {
      const isSchemaProp = schemaProps.has(prop);
      const isObjectProp = objectProps.has(prop);
      if (isObjectProp && !isSchemaProp) {
        errors.push(
          new ValidationError('unresolvedProperty', `${path}${prop}`)
        );
        continue;
      }

      const definition = schema[prop];

      if (extractDecorator(definition) === 'Validate' && !patch) {
        if (!definition(object)) {
          errors.push(new ValidationError('validation', `${path}${prop}`));
        }
        continue;
      }

      if (definition.readOnly && patch) {
        errors.push(new ValidationError('immutable', `${path}${prop}`));
        continue;
      }

      if (!isObjectProp) {
        if (definition.required && !patch) {
          errors.push(new ValidationError('missingProperty', `${path}${prop}`));
        }
        continue;
      }

      const value = object[prop];

      if (value === undefined || value === null) {
        if (definition.required) {
          errors.push(new ValidationError('emptyValue', `${path}${prop}`));
        }
        continue;
      }

      if (definition.domain) {
        errors.push(
          ...validateDomain(value, `${path}${prop}`, definition.definition)
        );
      } else if (definition.category) {
        errors.push(
          ...validateLink(value, `${path}${prop}`, definition, this, patch)
        );
      }

      if (definition.validate && !definition.validate(value)) {
        errors.push(new ValidationError('propValidation', `${path}${prop}`));
      }
    }
    return errors;
  }

  // Validate instance against a category
  //   categoryName <string>, category name
  //   instance <any>, instance to validate
  //   patch <boolean>, flag to determine if the object contains patch or
  //       value, default: `false`
  //   path <string>, path to an object, for nested objects, default: `''`
  // Returns: <MetaschemaError> | <null>
  validateCategory(categoryName, instance, patch = false, path = '') {
    const category = this.categories.get(categoryName);
    if (!category) {
      return new MetaschemaError([
        new ValidationError('undefinedEntity', categoryName, 'category'),
      ]);
    }

    const errors = this[validate](
      category.definition,
      instance,
      patch,
      `${path}${categoryName}.`
    );

    return errors.length === 0 ? null : new MetaschemaError(errors);
  }

  // Validate arguments of an action
  //   category <string>
  //   action <string>
  //   args <Object>, action arguments
  // Returns: <MetaschemaError> | <null>
  validateAction(category, actionName, args) {
    const cat = this.categories.get(category);
    if (!cat) {
      return new MetaschemaError([
        new ValidationError('undefinedEntity', category, 'category'),
      ]);
    }

    const action = cat.actions.get(actionName);
    if (!action) {
      return new MetaschemaError([
        new ValidationError('undefinedEntity', actionName, 'action'),
      ]);
    }

    const errors = this[validate](
      action.definition.Args,
      args,
      false,
      `${category}.${actionName}.`
    );

    return errors.length === 0 ? null : new MetaschemaError(errors);
  }

  // Validate fields of an instance against a category
  //   category <string>, category name
  //   instance <any>, instance to validate
  // Returns: <MetaschemaError> | <null>
  validateFields(category, instance) {
    const errors = [];
    for (const key in instance) {
      const val = instance[key];
      const err = this.validateCategory(category, val, false, `${key}.`);
      if (err) errors.push(...err.errors);
    }
    return errors.length === 0 ? null : new MetaschemaError(errors);
  }

  buildCategory(category, ...args) {
    return this.categories.get(category).factory(...args);
  }
}

const addDomains = (ms, schemas) => {
  const errors = [];

  for (const { definition: domains } of schemas) {
    for (const [name, domain] of Object.entries(domains)) {
      if (ms.domains.has(name)) {
        errors.push(
          new SchemaValidationError('duplicate', name, null, {
            entity: 'domain',
          })
        );
        continue;
      }

      const decorator = extractDecorator(domain);
      if (decorator === 'Flags' && domain.enum) {
        const enumDomain = ms.domains.get(domain.enum);
        domain.values = enumDomain.values;
      }
      ms.domains.set(name, domain);
    }
  }

  return errors;
};

const addCategories = (ms, categories) => {
  const errors = [];

  for (const { name, definition } of categories) {
    if (ms.categories.has(name)) {
      errors.push(
        new SchemaValidationError('duplicate', name, null, {
          entity: 'category',
        })
      );
      continue;
    }

    ms.categories.set(name, {
      name,
      definition,
      actions: new Map(),
      views: new Map(),
      forms: new Map(),
      factory: ms[factorify](name, definition),
      references: iter(REFERENCE_TYPES).reduce((references, type) => {
        references[type] = [];
        return references;
      }, {}),
    });
  }

  return errors;
};

const categoryDataProps = [
  ['form', 'forms'],
  ['action', 'actions'],
  ['view', 'views'],
];

const addCategoryData = (ms, schemas) => {
  const errors = [];

  for (const [type, prop] of categoryDataProps) {
    for (const entity of schemas[prop]) {
      const category = ms.categories.get(entity.category);
      if (!entity.category) {
        errors.push(
          new SchemaValidationError('unlinked', entity.name, null, {
            entity: type,
          })
        );
      } else if (!category) {
        errors.push(
          new SchemaValidationError(
            'unresolvedCategory',
            entity.category,
            entity.name,
            { category: entity.category }
          )
        );
      } else if (category.actions.has(entity.name)) {
        errors.push(
          new SchemaValidationError(
            'duplicate',
            `${entity.category}.${entity.name}`,
            null,
            { entity: type }
          )
        );
      } else {
        category[prop].set(entity.name, entity);
      }
    }
  }

  return errors;
};

// Creates Metaschema instance
//   schemas <Iterable> schemas in form [name, schema, source]
//             (the 'source' is optional)
// Returns: [<MetaschemaError>, <Metaschema>]
const create = schemas => {
  const ms = new Metaschema(schemas);

  const errors = [
    ...addDomains(ms, schemas.domains),
    ...addCategories(ms, schemas.categories),
    ...addCategoryData(ms, schemas),
  ];

  if (errors.length) {
    return [new MetaschemaError(errors), ms];
  }

  const error =
    processDomains(ms) ||
    processCategories(ms) ||
    processActions(ms) ||
    processViews(ms) ||
    processForms(ms);

  return [error, ms];
};

module.exports = {
  create,
};
