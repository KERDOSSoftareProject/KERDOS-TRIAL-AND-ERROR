// KERDOS query vocabulary. Adapters receive plain operation descriptions;
// services do not receive a database SDK or its query objects.
export function createRecords(execute) {
  if (typeof execute !== "function") throw new Error("Records adapter requires execute");
  return {query(table) {
    const spec={table,action:null,filters:[],orders:[],cardinality:null};
    const chain={
      select(columns="*"){spec.columns=columns;if(!spec.action)spec.action="select";return chain;},
      insert(value){spec.action="insert";spec.value=value;return chain;},
      update(value){spec.action="update";spec.value=value;return chain;},
      upsert(value){spec.action="upsert";spec.value=value;return chain;},
      delete(){spec.action="delete";return chain;},
      eq(column,value){spec.filters.push({operator:"eq",column,value});return chain;},
      in(column,value){spec.filters.push({operator:"in",column,value});return chain;},
      ilike(column,value){spec.filters.push({operator:"ilike",column,value});return chain;},
      lte(column,value){spec.filters.push({operator:"lte",column,value});return chain;},
      order(column,options){spec.orders.push({column,options});return chain;},
      range(from,to){spec.range={from,to};return chain;},
      limit(value){spec.limit=value;return chain;},
      single(){spec.cardinality="single";return chain;},
      maybeSingle(){spec.cardinality="maybeSingle";return chain;},
      then(resolve,reject){
        if(!spec.action) return Promise.reject(new Error("Records query needs an action")).then(resolve,reject);
        return Promise.resolve().then(()=>execute({ ...spec,filters:[...spec.filters],orders:[...spec.orders] })).then(resolve,reject);
      },
    };
    return chain;
  }};
}
