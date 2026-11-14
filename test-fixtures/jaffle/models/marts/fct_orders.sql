select *
from {{ ref('int_orders') }}
join {{ ref('stg_customers') }} using (customer_id)
join {{ ref('stg_orders') }} using (order_id)
join {{ ref('utils', 'calendar') }} using (date_day)
