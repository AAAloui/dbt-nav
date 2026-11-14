select o.*, p.amount
from {{ ref('stg_orders') }} o
join {{ ref('stg_payments') }} p using (order_id)
