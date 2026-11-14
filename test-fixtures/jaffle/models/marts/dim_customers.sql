select * from {{ ref('stg_customers') }} left join {{ ref('fct_orders') }} using (customer_id)
