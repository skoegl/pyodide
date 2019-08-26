for i in */
do
	grep "requirements:" ${i}/meta.yaml >/dev/null 2>&1

	if [ $? -eq 0 ]
	then
		echo "--- $i CHECK ---"
		cat ${i}meta.yaml
	else
		echo "--- $i OK! ---"
	fi
done

