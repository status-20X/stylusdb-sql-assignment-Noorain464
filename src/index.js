const {parseQuery} = require('./queryParser');
const readCSV = require('./csvReader');
function performInnerJoin(data, joinData, joinCondition, fields, table) {
    return data.flatMap(mainRow => {
        return joinData
            .filter(joinRow => {
                const mainValue = mainRow[joinCondition.left.split('.')[1]];
                const joinValue = joinRow[joinCondition.right.split('.')[1]];
                return mainValue === joinValue;
            })
            .map(joinRow => {
                return fields.reduce((acc, field) => {
                    const [tableName, fieldName] = field.split('.');
                    acc[field] = tableName === table ? mainRow[fieldName] : joinRow[fieldName];
                    return acc;
                }, {});
            });
    });
}

function performLeftJoin(data, joinData, joinCondition, fields, table) {
    return data.flatMap(mainRow => {
        const matchingJoinRows = joinData.filter(joinRow => {
            const mainValue = getValueFromRow(mainRow, joinCondition.left);
            const joinValue = getValueFromRow(joinRow, joinCondition.right);
            return mainValue === joinValue;
        });

        if (matchingJoinRows.length === 0) {
            return [createResultRow(mainRow, null, fields, table, true)];
        }

        return matchingJoinRows.map(joinRow => createResultRow(mainRow, joinRow, fields, table, true));
    });
}

function getValueFromRow(row, compoundFieldName) {
    const [tableName, fieldName] = compoundFieldName.split('.');
    return row[`${tableName}.${fieldName}`] || row[fieldName];
}

function performRightJoin(data, joinData, joinCondition, fields, table) {
   
    const mainTableRowStructure = data.length > 0 ? Object.keys(data[0]).reduce((acc, key) => {
        acc[key] = null; 
        return acc;
    }, {}) : {};

    return joinData.map(joinRow => {
        const mainRowMatch = data.find(mainRow => {
            const mainValue = getValueFromRow(mainRow, joinCondition.left);
            const joinValue = getValueFromRow(joinRow, joinCondition.right);
            return mainValue === joinValue;
        });
        const mainRowToUse = mainRowMatch || mainTableRowStructure;

        return createResultRow(mainRowToUse, joinRow, fields, table, true);
    });
}
function createResultRow(mainRow, joinRow, fields, table, includeAllMainFields) {
    const resultRow = {};

    if (includeAllMainFields) {
        Object.keys(mainRow || {}).forEach(key => {
            const prefixedKey = `${table}.${key}`;
            resultRow[prefixedKey] = mainRow ? mainRow[key] : null;
        });
    }
    fields.forEach(field => {
        const [tableName, fieldName] = field.includes('.') ? field.split('.') : [table, field];
        resultRow[field] = tableName === table && mainRow ? mainRow[fieldName] : joinRow ? joinRow[fieldName] : null;
    });

    return resultRow;
}

async function executeSELECTQuery(query) {
    const { fields, table, whereClauses, joinType, joinTable, joinCondition, groupByFields, hasAggregateWithoutGroupBy } = parseQuery(query);
    let data = await readCSV(`${table}.csv`);

    // Logic for applying JOINs
    if (joinTable && joinCondition) {
        const joinData = await readCSV(`${joinTable}.csv`);
        switch (joinType.toUpperCase()) {
            case 'INNER':
                data = performInnerJoin(data, joinData, joinCondition, fields, table);
                break;
            case 'LEFT':
                data = performLeftJoin(data, joinData, joinCondition, fields, table);
                break;
            case 'RIGHT':
                data = performRightJoin(data, joinData, joinCondition, fields, table);
                break;
            default:
                throw new Error('Unsupported JOIN type.');
        }
    }
    if (groupByFields) {
        data = applyGroupBy(data, groupByFields, fields);
    }
    // Apply WHERE clause filtering after JOIN (or on the original data if no join)
    let filteredData = whereClauses.length > 0
        ? data.filter(row => whereClauses.every(clause => evaluateCondition(row, clause)))
        : data;

        let groupResults = filteredData;
        if (hasAggregateWithoutGroupBy) {
            // Special handling for queries like 'SELECT COUNT(*) FROM table'
            const result = {};
    fields.forEach(field => {
        const match = /(\w+)\((\*|\w+)\)/.exec(field);
        if (match) {
            const [, aggFunc, aggField] = match;
            switch (aggFunc.toUpperCase()) {
                case 'COUNT':
                    result[field] = filteredData.length;
                    break;
                case 'SUM':
                    result[field] = filteredData.reduce((acc, row) => acc + parseFloat(row[aggField]), 0);
                    break;
                case 'AVG':
                    result[field] = filteredData.reduce((acc, row) => acc + parseFloat(row[aggField]), 0) / filteredData.length;
                    break;
                case 'MIN':
                    result[field] = Math.min(...filteredData.map(row => parseFloat(row[aggField])));
                    break;
                case 'MAX':
                    result[field] = Math.max(...filteredData.map(row => parseFloat(row[aggField])));
                    break;
            }
        }
    });

    return [result];
       
        } else if (groupByFields) {
            groupResults = applyGroupBy(filteredData, groupByFields, fields);
            return groupResults;
        } else {
            // Select the specified fields
            return groupResults.map(row => {
                const selectedRow = {};
                fields.forEach(field => {
                    // Assuming 'field' is just the column name without table prefix
                    selectedRow[field] = row[field];
                });
                return selectedRow;
            });
        }
}
function evaluateCondition(row, clause) {
    let { field, operator, value } = clause;
    // Check if the field exists in the row
    if (row[field] === undefined) {
        throw new Error(`Invalid field: ${field}`);
    }
    // Parse row value and condition value based on their actual types
    const rowValue = parseValue(row[field]);
    let conditionValue = parseValue(value);
    switch (operator) {
        case '=': return rowValue === conditionValue;
        case '!=': return rowValue !== conditionValue;
        case '>': return rowValue > conditionValue;
        case '<': return rowValue < conditionValue;
        case '>=': return rowValue >= conditionValue;
        case '<=': return rowValue <= conditionValue;
        default: throw new Error(`Unsupported operator: ${operator}`);
    }
}
function parseValue(value) {
    // Return null or undefined as is
    if (value === null || value === undefined) {
        return value;
    }
    // If the value is a string enclosed in single or double quotes, remove them
    if (typeof value === 'string' && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
        value = value.substring(1, value.length - 1);
    }
    // Check if value is a number
    if (!isNaN(value) && value.trim() !== '') {
        return Number(value);
    }
    // Assume value is a string if not a number
    return value;
}
function applyGroupBy(data, groupByFields, aggregateFunctions) {
    const groupResults = {};

    data.forEach(row => {
        // Generate a key for the group
        const groupKey = groupByFields.map(field => row[field]).join('-');

        // Initialize group in results if it doesn't exist
        if (!groupResults[groupKey]) {
            groupResults[groupKey] = { count: 0 };
            groupByFields.forEach(field => groupResults[groupKey][field] = row[field]);
        }

        // Increment count for each group
        groupResults[groupKey].count += 1;
    });

    // Convert grouped results into an array format
    return Object.values(groupResults).map(group => {
        // Construct the final grouped object based on required fields
        const finalGroup = {};
        groupByFields.forEach(field => finalGroup[field] = group[field]);
        aggregateFunctions.forEach(func => {
            if (func.toUpperCase() === 'COUNT(*)') {
                finalGroup[func] = group.count;
            }
        });

        return finalGroup;
    });
}


module.exports = executeSELECTQuery;